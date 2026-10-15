import { randomUUID } from "node:crypto";
import type { MpArchiveState } from "@aihot/contracts/mp";
import { sql, type Db } from "../db.ts";
import { audit } from "../audit.ts";
import { upsertMaterial } from "../content/materials.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { normalizeMpBody } from "../content/mp-body.ts";
import { stripTags } from "../lib/text.ts";
import { identityKeyForUrl } from "../lib/url.ts";
import { credential } from "../config.ts";
import { mpArticle, mpHistory } from "../providers/dajiala.ts";
import { everyinfraHistory } from "../providers/everyinfra.ts";
import { fetchWechatPage, WechatPausedError } from "../providers/wechat-page.ts";
import { BudgetExceededError, ProviderRejectedError } from "../providers/receipts.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";

const stateKey = (id: string) => `mp_archive:${id}`;
export async function archiveState(sourceId: string): Promise<MpArchiveState | null> {
  const [s] = await sql<{ value: MpArchiveState }[]>`SELECT value FROM settings WHERE key = ${stateKey(sourceId)}`;
  return s?.value ?? null;
}

/** The paid path is not limited by the WeChat page protection, so its batches may be larger. */
const MAX_BATCH = { page: 20, dajiala: 100 };
/** A batch stops before the queue's 30-minute job expiry, and another click continues it. */
const BATCH_MS = 25 * 60_000;

/** Paid outcomes that stop a batch, in plain words; null when the article itself was refused. */
function paidStop(error: unknown): string | null {
  // The hour and day windows roll, so no exact time is promised here.
  if (error instanceof BudgetExceededError) return "极致了达到每小时或每天的预算上限，稍后再点继续；可在后台预算里调高";
  if (error instanceof ProviderRejectedError && error.status === 20001) return "极致了余额不足，充值后再点继续";
  if (error instanceof ProviderRejectedError && error.retryable) return "极致了限流，稍后再点继续";
  return null;
}

export async function archiveAction(sourceId: string, input: { action: "list" | "bodies" | "pause"; maxRequests?: number; bodyProvider?: "page" | "dajiala" }, actor: string) {
  if (!["list", "bodies", "pause"].includes(input.action)) throw Object.assign(new Error("Unknown archive action"), { statusCode: 400 });
  const bodyProvider = input.bodyProvider ?? "page";
  if (!["page", "dajiala"].includes(bodyProvider)) throw Object.assign(new Error("Unknown body provider"), { statusCode: 400 });
  if (input.action !== "pause" && process.env.COLLECT_ENABLED === "false") throw Object.assign(new Error("采集已关闭，请先启用 COLLECT_ENABLED"), { statusCode: 400 });
  const maxRequests = input.maxRequests ?? 5;
  const maxBatch = input.action === "bodies" ? MAX_BATCH[bodyProvider] : MAX_BATCH.page;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > maxBatch) throw Object.assign(new Error(`每批请求上限必须为1至${maxBatch}`), { statusCode: 400 });
  const [source] = await sql<{ config: { listProvider?: "dajiala" | "everyinfra" } }[]>`SELECT config FROM sources WHERE id = ${sourceId} AND kind = 'mp_account'`;
  if (!source) return null;
  // Bodies come from the public article page; only the history list is paid, from the account's list provider.
  const listProvider = source.config.listProvider ?? "dajiala";
  const listKey = listProvider === "everyinfra" ? "EVERYINFRA_API_KEY" : "DAJIALA_KEY";
  if (input.action === "list" && !credential("collectors", listKey)) throw Object.assign(new Error(`历史列表需要配置 ${listKey}`), { statusCode: 400 });
  if (input.action === "bodies" && bodyProvider === "dajiala" && !credential("collectors", "DAJIALA_KEY")) throw Object.assign(new Error("极致了补全文需要配置 DAJIALA_KEY"), { statusCode: 400 });
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${stateKey(sourceId)}))`;
    const [saved] = await tx<{ value: MpArchiveState }[]>`SELECT value FROM settings WHERE key = ${stateKey(sourceId)} FOR UPDATE`;
    const previous = saved?.value;
    if (input.action !== "pause" && previous && (["queued", "running"].includes(previous.status) || Date.parse(previous.workingUntil ?? "") > Date.now())) throw Object.assign(new Error("归档任务正在执行，请先暂停或等待完成"), { statusCode: 409 });
    const mode = input.action === "bodies" ? "bodies" : "list";
    const next: MpArchiveState = previous ? { ...previous } : {
      runId: randomUUID(), mode, status: "queued", offset: "", pages: 0, stored: 0, bodies: 0, failed: 0,
      listComplete: false, lastReceiptId: null, error: null,
    };
    if (input.action === "pause") next.status = "paused";
    else {
      if (mode === "list" && (previous?.listProvider ?? "dajiala") !== listProvider) { next.offset = ""; next.listComplete = false; }
      if (mode === "list" && next.listComplete) {
        throw Object.assign(new Error(listProvider === "everyinfra" ? "万有引擎只能获取最近一批文章，已获取；更早的文章请把列表服务商改为极致了后再归档" : "历史列表已遍历完成；新增文章请使用立即采集"), { statusCode: 409 });
      }
      if (mode === "list") next.listProvider = listProvider;
      else next.bodyProvider = bodyProvider;
      next.mode = mode; next.status = "queued"; next.error = null;
    }
    await tx`INSERT INTO settings (key, value, updated_by) VALUES (${stateKey(sourceId)}, ${tx.json(next as never)}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    if (input.action !== "pause") await enqueue(QUEUES.mpArchive, { sourceId, runId: next.runId, maxRequests }, { singletonKey: `archive:${sourceId}` }, tx);
    await audit(actor, "source.archive", `source:${sourceId}`, null, previous ?? null, { action: input.action, maxRequests }, { db: tx });
    return next;
  });
}

async function save(sourceId: string, state: MpArchiveState, db: Db = sql): Promise<void> {
  // A pause arriving during a paid request wins, while the already received progress is retained.
  await db`UPDATE settings SET value = ${db.json(state as never)} ||
    CASE WHEN value->>'status' = 'paused' THEN '{"status":"paused"}'::jsonb ELSE '{}'::jsonb END,
    updated_at = now() WHERE key = ${stateKey(sourceId)} AND value->>'runId' = ${state.runId}`;
}

export async function runMpArchive(sourceId: string, runId: string, maxRequests: number) {
  let state = await archiveState(sourceId);
  if (!state || state.runId !== runId || state.status === "paused") return;
  const [source] = await sql<{ config: { ghid?: string; wxid?: string } }[]>`SELECT config FROM sources WHERE id = ${sourceId} AND kind = 'mp_account'`;
  const account = source?.config.ghid ?? source?.config.wxid;
  if (!account) { state.status = "error"; state.error = "公众号缺少 ghid 或 wxid"; await save(sourceId, state); return; }
  const started = Date.now();
  state = { ...state, status: "running", workingUntil: new Date(started + 1800_000).toISOString() };
  await save(sourceId, state);
  try {
    for (let n = 0; n < maxRequests; n++) {
      if ((await archiveState(sourceId))?.status === "paused") return;
      if (Date.now() - started > BATCH_MS) break;
      if (state.mode === "list") {
        if (state.listComplete) break;
        const everyinfra = state.listProvider === "everyinfra";
        const page = everyinfra
          ? await everyinfraHistory(account, { subject: sourceId, window: `archive:${runId}`, async: true })
          : await mpHistory(account, { subject: sourceId, window: `archive:${runId}`, offset: state.offset });
        // EveryInfra has no paging: its one listing is all it can reach. An empty listing reached nothing,
        // so it does not complete the list and another click may ask again.
        const emptyListing = everyinfra && page.posts.length === 0;
        const isEnd = everyinfra ? !emptyListing : page.isEnd === true;
        const invalidCursor = !everyinfra && !isEnd && (!page.nextOffset || page.nextOffset === state.offset);
        let stored = 0;
        await sql.begin(async (tx) => {
          for (const p of page.posts) {
            if (!p.url || !p.title) continue;
            const identity = identityKeyForUrl(p.url);
            const [known] = await tx`SELECT id FROM articles WHERE identity_key = ${identity}`;
            if (known) continue;
            const r = await upsertMaterial({ sourceId, url: p.url, title: p.title, language: "zh", excerpt: p.digest,
              publishedAt: p.post_time ? new Date(p.post_time * 1000) : null, bodyStatus: "none", via: "import", backfill: "mp-archive", raw: { mpArchive: true } }, tx);
            if (r.created) {
              await tx`UPDATE articles SET processing_state = 'skipped' WHERE id = ${r.articleId}`;
              stored++;
            }
          }
          state.pages++; state.listed = (state.listed ?? 0) + page.posts.length; state.stored += stored; state.offset = page.nextOffset ?? state.offset;
          state.listComplete = isEnd; state.lastReceiptId = page.receiptId;
          await save(sourceId, state, tx);
        });
        if (invalidCursor) throw new Error("服务商未返回可继续的分页游标，本页已保存；已停止，不重复购买同一页");
        if (emptyListing) throw new Error("万有引擎本次未返回文章，列表未标记完成；费用以后台回执为准，可稍后再试");
      } else {
        // Every stored article of the account still without a body, archived or collected daily. One with a body is never asked for again.
        const [article] = await sql<{ id: string; url: string; title: string; excerpt: string | null; published_at: Date | null; processing_state: string }[]>`
          SELECT id, url, title, excerpt, published_at, processing_state FROM articles WHERE source_id = ${sourceId}
            AND body_status <> 'ok' AND raw->>'mpBodyFailed' IS NULL ORDER BY published_at DESC NULLS LAST, id LIMIT 1`;
        if (!article) { state.status = "completed"; break; }
        let body: { content: string; author: string | null };
        let refused: string | null = null;
        if (state.bodyProvider === "dajiala") {
          // Same receipt identity as the daily collector used (sn, else URL): a body bought before is reused, not paid again.
          const identity = new URL(article.url).searchParams.get("sn") ?? article.url;
          try {
            const paid = await mpArticle(article.url, { subject: sourceId, identity });
            if (!paid.reused) state.paidBodies = (state.paidBodies ?? 0) + 1;
            body = paid;
          } catch (error) {
            // The per-minute budget only spaces requests out: wait for it within the batch.
            if (error instanceof BudgetExceededError && error.retryAfterSeconds <= 60) {
              await new Promise((resolve) => setTimeout(resolve, error.retryAfterSeconds * 1000));
              n--; continue;
            }
            // Budget, balance and rate limits stop the batch. Another refusal counts this article as empty and
            // also stops, so a refusal that is not about the article (a bad key) cannot mark a whole batch.
            if (paidStop(error) || !(error instanceof ProviderRejectedError)) throw error;
            body = { content: "", author: null };
            refused = `极致了拒绝了《${article.title}》：${error.message}；已计入空正文，可再点继续`;
          }
        } else {
          // The archive is unattended: it may wait longer for its turn than a scheduled check.
          body = await fetchWechatPage(article.url, { maxWaitMs: 600_000 });
        }
        if (!body.content) {
          await sql.begin(async tx => {
            await tx`UPDATE articles SET raw = raw || '{"mpBodyFailed":true}'::jsonb WHERE id = ${article.id}`;
            state.failed++;
            await save(sourceId, state, tx);
          });
          if (refused) throw new Error(refused);
        } else {
          const html = sanitizeBody(normalizeMpBody(body.content), article.url);
          await sql.begin(async (tx) => {
            const r = await upsertMaterial({ sourceId, url: article.url, title: article.title, language: "zh", author: body.author,
              publishedAt: article.published_at, excerpt: article.excerpt, bodyHtml: html, bodyText: stripTags(html), bodyStatus: "ok",
              via: "import", backfill: "mp-archive", raw: { mpArchive: true } }, tx);
            // A body filled in here never sends the article (back) to paid analysis. A body the article had
            // before is no revision, so the status is set here too, or the batch would pick it again.
            await tx`UPDATE articles SET processing_state = ${article.processing_state},
              body_status = CASE WHEN body_text IS NULL THEN body_status ELSE 'ok' END WHERE id = ${r.articleId}`;
            state.bodies++;
            await save(sourceId, state, tx);
          });
        }
      }
      await save(sourceId, state);
      if (state.mode === "list" && state.listComplete) { state.status = "completed"; break; }
    }
    if (state.status === "running") state.status = "paused"; // Batch limit: continue only on another explicit click.
    await save(sourceId, state);
  } catch (error) {
    // Held back by the WeChat rate protection or a paid limit: paused, not failed; another click continues later.
    const stop = paidStop(error);
    state.status = error instanceof WechatPausedError || stop ? "paused" : "error";
    state.error = stop ?? (error instanceof Error ? error.message.slice(0, 400) : "归档失败");
    await save(sourceId, state);
  } finally {
    state.workingUntil = null;
    await save(sourceId, state);
  }
}
