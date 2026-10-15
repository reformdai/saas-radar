// Private summaries only. Nothing here writes public articles or publication queues.
import { z } from "zod";
import type { WechatDigest, WechatDigestDetail, WechatDigestFeed, WechatMessage } from "@aihot/contracts/wechat";
import { sql, type Db } from "../db.ts";
import { config } from "../config.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { DIGEST_PROMPT, DIGEST_VERSION, digestHash, digestSchema, parseDigestResponse, summarizeWechat, type DigestCall } from "./digest-content.ts";
import { readableWechatContent } from "./message-content.ts";

const keySchema = z.object({ account: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  group: z.string().regex(/^[\w-]+@chatroom$/).max(120), day: z.iso.date() });
export type DigestKey = z.infer<typeof keySchema>;
export const wechatDay = (seconds: number) => new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 10);
export const summariesEnabled = () => process.env.WECHAT_SUMMARIES_ENABLED === "true" && config.modelCallsEnabled;

export async function digestStoreReady(db: Db = sql): Promise<boolean> {
  const [row] = await db<{ ready: boolean }[]>`SELECT to_regclass('wechat_digests') IS NOT NULL AS ready`;
  return !!row?.ready;
}

/** Appends retain a safe previous snapshot; edits/revocations clear it immediately. */
export async function invalidateWechatDigest(db: Db, account: string, group: string, day: string, appendOnly = false) {
  await db`INSERT INTO wechat_digests (account, group_id, day) VALUES (${account}, ${group}, ${day})
    ON CONFLICT (account, group_id, day) DO UPDATE SET revision = wechat_digests.revision + 1,
      status = CASE WHEN ${appendOnly} AND wechat_digests.status = 'ready' THEN 'ready' ELSE 'pending' END,
      points = CASE WHEN ${appendOnly} AND wechat_digests.status = 'ready' THEN wechat_digests.points ELSE '[]'::jsonb END,
      error = NULL, updated_at = CASE WHEN ${appendOnly} AND wechat_digests.status = 'ready' THEN wechat_digests.updated_at ELSE now() END`;
}

async function dayMessages(key: DigestKey, db: Db = sql): Promise<WechatMessage[]> {
  const start = Date.parse(`${key.day}T00:00:00+08:00`) / 1000;
  const messages = await db<WechatMessage[]>`SELECT message_id, group_id, sender_id, sender_name, content,
    sent_at::float8 AS sent_at, revoked FROM wechat_messages
    WHERE account = ${key.account} AND group_id = ${key.group} AND sent_at >= ${start} AND sent_at < ${start + 86400}
    ORDER BY sent_at, message_id`;
  return messages.map(m => ({ ...m, content: readableWechatContent(m.content) }));
}

export async function wechatDigestFeed(query: Record<string, unknown>): Promise<WechatDigestFeed> {
  if (!await digestStoreReady()) return { ready: false, enabled: summariesEnabled(), items: [], hasMore: false };
  const page = Math.max(1, Math.min(10000, Math.floor(Number(query.page) || 1)));
  const groups = summaryGroups();
  const rows = await sql<WechatDigest[]>`SELECT d.account, d.group_id, g.name, d.day::text, d.status,
    CASE WHEN d.status = 'ready' THEN d.points ELSE '[]'::jsonb END AS points,
    d.message_count, d.updated_at, d.error FROM wechat_digests d
    JOIN wechat_groups g USING (account, group_id) WHERE g.enabled AND (d.status = 'ready' OR (${summariesEnabled()} AND (g.account || ':' || g.group_id) IN ${sql(groups.length ? groups : [''])} AND d.day BETWEEN (now() AT TIME ZONE 'Asia/Shanghai')::date - 1 AND (now() AT TIME ZONE 'Asia/Shanghai')::date))
    ORDER BY d.day DESC, d.updated_at DESC, d.account, d.group_id LIMIT 21 OFFSET ${(page - 1) * 20}`;
  return { ready: true, enabled: summariesEnabled(), items: rows.slice(0, 20), hasMore: rows.length > 20 };
}

export async function wechatDigestDetail(query: Record<string, unknown>): Promise<WechatDigestDetail | null> {
  const key = keySchema.parse(query);
  if (!await digestStoreReady()) return null;
  // One statement obtains both summary and evidence from the same MVCC snapshot.
  const start = Date.parse(`${key.day}T00:00:00+08:00`) / 1000;
  const [row] = await sql<(WechatDigest & { messages: WechatMessage[] })[]>`SELECT d.account, d.group_id, g.name, d.day::text, d.status,
    CASE WHEN d.status = 'ready' THEN d.points ELSE '[]'::jsonb END AS points,
    d.message_count, d.updated_at, d.error,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('message_id', m.message_id, 'group_id', m.group_id,
      'sender_id', m.sender_id, 'sender_name', m.sender_name, 'content', m.content, 'sent_at', m.sent_at, 'revoked', m.revoked)
      ORDER BY m.sent_at, m.message_id) FROM wechat_messages m
      WHERE m.account = d.account AND m.group_id = d.group_id AND NOT m.revoked
      AND m.sent_at >= ${start} AND m.sent_at < ${start + 86400} AND d.status = 'ready'
      AND m.message_id IN (SELECT jsonb_array_elements_text(point->'evidenceIds') FROM jsonb_array_elements(d.points) point)), '[]'::jsonb) AS messages
    FROM wechat_digests d JOIN wechat_groups g USING (account, group_id)
    WHERE d.account = ${key.account} AND d.group_id = ${key.group} AND d.day = ${key.day} AND g.enabled`;
  if (!row) return null;
  const { messages, ...digest } = row;
  return { digest, messages: messages.map(m => ({ ...m, content: readableWechatContent(m.content) })) };
}

/** Serializes one group/day across worker processes; no group row is locked during model calls. */
export async function buildWechatDigest(key: DigestKey, generate?: DigestCall) {
  keySchema.parse(key);
  if (!generate && !summariesEnabled()) return { skipped: true };
  const connection = await sql.reserve();
  const lock = `${key.account}/${key.group}/${key.day}`;
  let locked = false;
  const receipts: number[] = [];
  let revision: number | undefined;
  try {
    const [acquired] = await connection<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('wechat-digest'), hashtext(${lock})) AS locked`;
    locked = !!acquired?.locked;
    if (!locked) return { skipped: true };
    const [record] = await sql<{ revision: number; status: string; input_hash: string | null }[]>`UPDATE wechat_digests d SET attempted_at = now()
      FROM wechat_groups g WHERE d.account = ${key.account} AND d.group_id = ${key.group} AND d.day = ${key.day}
      AND g.account = d.account AND g.group_id = d.group_id AND g.enabled RETURNING d.revision, d.status, d.input_hash`;
    if (!record) return { skipped: true };
    revision = record.revision;
    const messages = await dayMessages(key);
    const inputHash = digestHash(messages);
    if (record.status === "ready" && record.input_hash === inputHash) return { skipped: true };
    const call: DigestCall = generate ?? (async (material, allowed, stage) => {
      const result = await chatJson({ model: "default", purpose: "wechat_digest", subject: `wechat:${lock}`,
        promptVersion: `${DIGEST_VERSION}:${stage}`, system: DIGEST_PROMPT, user: JSON.stringify(material),
        schema: digestSchema(allowed), parse: parseDigestResponse, maxTokens: 6000 });
      receipts.push(result.receiptId);
      return result.data.points;
    });
    const points = await summarizeWechat(messages, call);
    return await sql.begin(async tx => {
      const [current] = await tx<{ revision: number }[]>`SELECT revision FROM wechat_digests
        WHERE account = ${key.account} AND group_id = ${key.group} AND day = ${key.day} FOR UPDATE`;
      if (!current) return { published: false, superseded: true };
      // New arrivals must not starve busy groups. Publish the checked snapshot, but never a
      // snapshot whose original messages were edited or revoked while the model was running.
      const originalIds = new Set(messages.map(m => m.message_id));
      const unchanged = current.revision === revision || digestHash((await dayMessages(key, tx)).filter(m => originalIds.has(m.message_id))) === inputHash;
      const updated = await tx`UPDATE wechat_digests SET status = 'ready', input_hash = ${inputHash},
        points = ${tx.json(points.map(p => ({ title: p.title, summary: p.summary, evidenceIds: p.evidenceIds })))}, message_count = ${messages.filter(m => !m.revoked).length},
        error = NULL, updated_at = now() WHERE account = ${key.account} AND group_id = ${key.group}
        AND day = ${key.day} AND revision = ${current.revision} AND ${unchanged} RETURNING account`;
      for (const id of receipts) await completeReceipt(tx, id);
      return { published: updated.length > 0, superseded: updated.length === 0 };
    });
  } catch {
    // Upstream errors can contain model response text. Keep private text out of job logs/errors.
    if (revision !== undefined) await sql`UPDATE wechat_digests SET status = 'error', error = '摘要生成失败，将自动重试；请检查模型配置、预算和消息规模。', updated_at = now()
      WHERE account = ${key.account} AND group_id = ${key.group} AND day = ${key.day} AND revision = ${revision}`;
    return { failed: true };
  } finally {
    try { if (locked) await connection`SELECT pg_advisory_unlock(hashtext('wechat-digest'), hashtext(${lock}))`; }
    finally { connection.release(); }
  }
}

/** Explicit account:group allowlist; an empty list never sends chat data to a model. */
export function summaryGroups(): string[] {
  return (process.env.WECHAT_SUMMARY_GROUPS ?? "").split(",").map(s => s.trim()).filter(Boolean)
    .map(value => {
      const [account, group, extra] = value.split(":");
      if (extra !== undefined) throw new Error("Invalid WECHAT_SUMMARY_GROUPS");
      keySchema.omit({ day: true }).parse({ account, group });
      return value;
    });
}

export async function summarizePendingWechat(generate?: DigestCall) {
  if ((!generate && !summariesEnabled()) || !await digestStoreReady()) return { skipped: true };
  const groups = summaryGroups();
  if (!groups.length) return { skipped: true };
  // Only today's and yesterday's messages; never backfill old imported history.
  await sql`INSERT INTO wechat_digests (account, group_id, day)
    SELECT m.account, m.group_id, (to_timestamp(m.sent_at) AT TIME ZONE 'Asia/Shanghai')::date
    FROM wechat_messages m JOIN wechat_groups g USING (account, group_id) WHERE g.enabled
    AND (g.account || ':' || g.group_id) IN ${sql(groups)}
    AND m.sent_at >= EXTRACT(EPOCH FROM (((now() AT TIME ZONE 'Asia/Shanghai')::date - 1)::timestamp AT TIME ZONE 'Asia/Shanghai'))
    AND m.sent_at < EXTRACT(EPOCH FROM (((now() AT TIME ZONE 'Asia/Shanghai')::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'))
    GROUP BY m.account, m.group_id, (to_timestamp(m.sent_at) AT TIME ZONE 'Asia/Shanghai')::date ON CONFLICT DO NOTHING`;
  const pending = await sql<{ account: string; group: string; day: string }[]>`SELECT d.account, d.group_id AS "group", d.day::text
    FROM wechat_digests d JOIN wechat_groups g USING (account, group_id)
    WHERE g.enabled AND (g.account || ':' || g.group_id) IN ${sql(groups)}
    AND d.day BETWEEN (now() AT TIME ZONE 'Asia/Shanghai')::date - 1 AND (now() AT TIME ZONE 'Asia/Shanghai')::date
    AND (d.status != 'ready' OR d.message_count != (SELECT count(*) FROM wechat_messages m
      WHERE m.account=d.account AND m.group_id=d.group_id AND NOT m.revoked
      AND m.sent_at >= EXTRACT(EPOCH FROM (d.day::timestamp AT TIME ZONE 'Asia/Shanghai'))
      AND m.sent_at < EXTRACT(EPOCH FROM ((d.day + 1)::timestamp AT TIME ZONE 'Asia/Shanghai'))))
    AND (d.attempted_at IS NULL OR d.attempted_at < now() - interval '30 minutes')
    ORDER BY d.attempted_at NULLS FIRST, d.day DESC LIMIT 12`;
  const results = [];
  for (const key of pending) results.push(await buildWechatDigest(key, generate));
  return { processed: results.length, results };
}
