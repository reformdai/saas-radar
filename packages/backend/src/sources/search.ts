// Active search (industry/search.ts): once a day a planned set of queries goes to a search provider and
// every result enters through the one material entrance like any collected item: identity and dedup,
// the timeline rule (no blanket backfill), body extraction and analysis, then publication. A result
// already stored keeps its source, title and body; the search only adds a discovery. The provider's
// snippet is kept as the summary, never as the body; its own ranking score is not used.
//
// Runs only with collection on, the provider switched on and its key configured. Every request goes
// through receipts: a same-day re-run reuses the answers, and an answer received but not stored (a
// crash, a failed write) is stored by the next run without paying again.
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SEARCH_LANES, type SearchLane } from "@aihot/industry/search";
import { credential, REPO_ROOT } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { identityKeyFor, upsertMaterial, type MaterialInput } from "../content/materials.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { queueProcessing } from "../jobs/content.ts";
import { shutdownSignal } from "../jobs/queue.ts";
import { chatJson } from "../providers/llm.ts";
import { BudgetExceededError, completeReceipt, ProviderRejectedError, rejectReceivedResponse } from "../providers/receipts.ts";
import { beijingDay, parseTavilyResponse, tavilySearch, tavilyUsage, type SearchDepth, type SearchHit, type SearchResult } from "../providers/tavily.ts";
import { listedCondition } from "../publication/scope.ts";

export interface PlannedQuery {
  lane: SearchLane;
  query: string;
  depth: SearchDepth;
  origin: "template" | "model";
}

/** What a search provider must offer (Tavily now; another one later implements the same). */
export interface SearchProvider {
  /** Key stored in raw.search and the source id (`<name>-search`). */
  name: string;
  /** Shown as the source's name. */
  label: string;
  /** The receipts service its requests are recorded under; recovery reads unstored answers back from there. */
  service: string;
  /** Why it must not run now (switched off, no key), or null. */
  skip(): string | null;
  search(q: PlannedQuery, now: Date): Promise<SearchResult>;
  /** The hits of a stored answer (recovery). */
  parse(response: unknown): SearchHit[];
  usage(db: Db, now: Date): Promise<Record<string, number>>;
}

export const TAVILY: SearchProvider = {
  name: "tavily",
  label: "Tavily",
  service: "tavily",
  skip: () => {
    if (process.env.TAVILY_SEARCH_ENABLED !== "true") return "disabled (TAVILY_SEARCH_ENABLED is not true)";
    if (!credential("collectors", "TAVILY_API_KEY")) return "no key (TAVILY_API_KEY)";
    return null;
  },
  search: (q, now) => tavilySearch(q.query, { depth: q.depth, lane: q.lane, now }),
  parse: parseTavilyResponse,
  usage: async (db, now) => ({ ...(await tavilyUsage(db, now)) }),
};

// ---------------------------------------------------------------------------
// The day's queries
// ---------------------------------------------------------------------------

const queryKey = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The day's plan: per lane its fixed templates first (rotated by date), then the model's queries,
 * then more templates until the lane is full. The first `advanced` of each lane search deeper.
 */
export function composePlan(day: string, generated: Array<{ lane: string; query: string }>): PlannedQuery[] {
  const dayIndex = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
  const used = new Set<string>();
  const plan: PlannedQuery[] = [];
  for (const lane of SEARCH_LANES) {
    const n = lane.templates.length;
    const start = n ? (dayIndex * lane.fixed) % n : 0;
    const rotated = lane.templates.map((_, i) => lane.templates[(start + i) % n]!);
    const picked: Array<{ query: string; origin: PlannedQuery["origin"] }> = [];
    const take = (query: string, origin: PlannedQuery["origin"]) => {
      const key = queryKey(query);
      if (picked.length >= lane.total || used.has(key)) return;
      used.add(key);
      picked.push({ query: query.replace(/\s+/g, " ").trim(), origin });
    };
    for (const t of rotated.slice(0, lane.fixed)) take(t, "template");
    for (const g of generated) if (g.lane === lane.lane) take(g.query, "model");
    for (const t of rotated) take(t, "template");
    picked.forEach((p, i) => plan.push({ lane: lane.lane, query: p.query, origin: p.origin, depth: i < lane.advanced ? "advanced" : "basic" }));
  }
  return plan;
}

const QueriesSchema = z.object({
  queries: z.array(z.object({ lane: z.string(), query: z.string() })).max(60),
});

/** A model query is used only when it is a plain, specific search line. */
function usableQuery(q: { lane: string; query: string }): boolean {
  const text = q.query.replace(/\s+/g, " ").trim();
  return SEARCH_LANES.some((l) => l.lane === q.lane) && text.length >= 8 && text.length <= 120 && !/site:|https?:|@|["“”]/i.test(text);
}

/** Pulls the JSON object out of a chat answer (a stored receipt read back). */
function cachedQueries(response: unknown): Array<{ lane: string; query: string }> | null {
  const content = (response as { choices?: Array<{ message?: { content?: string } }> } | null)?.choices?.[0]?.message?.content ?? "";
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = QueriesSchema.safeParse(JSON.parse(content.slice(start, end + 1)));
    return parsed.success ? parsed.data.queries : null;
  } catch {
    return null;
  }
}

function topicsText(): string {
  const { topics } = JSON.parse(readFileSync(path.join(REPO_ROOT, "industry/topics.json"), "utf8")) as { topics: Array<{ name: string; definition?: string }> };
  return topics.map((t) => `- ${t.name}：${t.definition ?? ""}`).join("\n");
}

/**
 * The model's queries for the day. Its input is public only (the topics and titles listed the day
 * before), and a same-day re-run reads back the morning's answer instead of asking again, even when
 * the input moved since. Any failure (model calls off, no model, unusable answer) leaves the templates.
 */
async function generateQueries(day: string): Promise<{ queries: Array<{ lane: string; query: string }>; cached: boolean }> {
  const subject = `search:${day}`;
  const [stored] = await sql<{ response: unknown }[]>`
    SELECT response FROM receipts WHERE purpose = 'search_queries' AND subject = ${subject} AND status IN ('received', 'completed')
    ORDER BY id DESC LIMIT 1`;
  const reused = stored ? cachedQueries(stored.response) : null;
  if (reused) return { queries: reused, cached: true };

  const dayStart = new Date(`${day}T00:00:00+08:00`);
  const titles = await sql<{ title: string }[]>`
    SELECT p.title FROM publications p
    WHERE ${listedCondition(dayStart)} AND p.discovered_at >= ${new Date(dayStart.getTime() - 86_400_000)} AND p.discovered_at < ${dayStart}
    ORDER BY p.discovered_at DESC, p.article_id DESC LIMIT 30`;
  const result = await chatJson({
    model: await modelFor("search"),
    purpose: "search_queries",
    subject,
    promptVersion: promptVersion("search-queries"),
    system: "",
    user: promptText("search-queries", {
      day,
      lanes: SEARCH_LANES.map((l) => `- ${l.lane}（写 ${l.total - l.fixed} 条）：${l.brief}`).join("\n"),
      topics: topicsText(),
      titles: titles.length ? titles.map((t) => `- ${t.title}`).join("\n") : "（无）",
      templates: SEARCH_LANES.flatMap((l) => l.templates.map((t) => `- ${t}`)).join("\n"),
    }),
    schema: QueriesSchema,
    temperature: 0.7,
    maxTokens: 1500,
  });
  await completeReceipt(sql, result.receiptId);
  return { queries: result.data.queries, cached: result.reused };
}

export async function planQueries(day: string): Promise<{ queries: PlannedQuery[]; model: "generated" | "cached" | "failed"; modelError?: string }> {
  try {
    const got = await generateQueries(day);
    return { queries: composePlan(day, got.queries.filter(usableQuery)), model: got.cached ? "cached" : "generated" };
  } catch (error) {
    if (shutdownSignal.signal.aborted) throw error;
    return { queries: composePlan(day, []), model: "failed", modelError: String(error instanceof Error ? error.message : error).slice(0, 300) };
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Provider answers that refuse the account itself (bad key, plan or credit limit): the rest of the run would fail the same way. */
const ACCOUNT_REFUSALS = new Set([401, 403, 432, 433]);

interface SearchMeta {
  lane: string;
  query: string;
  depth: string;
}

/** The hits of one answer, in one transaction with the receipt's completion. */
async function storeHits(sourceId: string, provider: string, q: SearchMeta, receiptId: number, hits: SearchHit[]): Promise<number> {
  return sql.begin(async (tx) => {
    let created = 0;
    for (const hit of hits) {
      const input: MaterialInput = {
        sourceId,
        url: hit.url,
        title: hit.title,
        excerpt: hit.content,
        bodyStatus: "pending",
        publishedAt: hit.publishedAt,
        via: "fetch",
        raw: { search: { provider, query: q.query, lane: q.lane, depth: q.depth } },
      };
      // Already stored, by this or any source: only the discovery is recorded. The search's title and
      // snippet never replace what is there, and nothing is queued again.
      const [known] = await tx<{ title: string }[]>`SELECT title FROM articles WHERE identity_key = ${identityKeyFor(input)}`;
      const res = await upsertMaterial(known ? { ...input, title: known.title, excerpt: null } : input, tx);
      if (res.created) {
        created += 1;
        await queueProcessing(res.articleId, { db: tx });
      }
    }
    await completeReceipt(tx, receiptId);
    return created;
  });
}

async function ensureSource(provider: SearchProvider): Promise<{ id: string; enabled: boolean }> {
  const id = `${provider.name}-search`;
  // Results come from anywhere on the web: no licence to show their full text, only summary and link.
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, enabled, health, tags, site_fulltext, syndicate_fulltext)
    VALUES (${id}, ${`${provider.label} 主动搜索`}, 'external', ${sql.json({ fetchPublicContent: true })}, 'T2', 'editorial', 1440, true, 'ok',
            ${["search:active"]}, false, false)
    ON CONFLICT (id) DO NOTHING`;
  const [s] = await sql<{ enabled: boolean }[]>`SELECT enabled FROM sources WHERE id = ${id}`;
  return { id, enabled: !!s?.enabled };
}

const message = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 300);

export async function runActiveSearch(opts: { provider?: SearchProvider; now?: Date } = {}): Promise<Record<string, unknown>> {
  const provider = opts.provider ?? TAVILY;
  if (process.env.COLLECT_ENABLED === "false") return { skipped: "collection off (COLLECT_ENABLED=false)" };
  const off = provider.skip();
  if (off) return { skipped: off };
  const source = await ensureSource(provider);
  if (!source.enabled) return { skipped: `source ${source.id} paused` };

  const now = opts.now ?? new Date();
  const day = beijingDay(now);
  const [run] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${source.id}) RETURNING id`;
  const c = { planned: 0, searched: 0, reused: 0, limited: 0, failed: 0, recovered: 0, found: 0, imported: 0 };
  const errors: string[] = [];
  let stopped: string | null = null;
  let model: string | null = null;
  let modelError: string | undefined;
  try {
    // Answers received but never stored: stored now, without paying again.
    const unstored = await sql<{ id: number; request: Record<string, unknown> | null; response: unknown }[]>`
      SELECT id, request, response FROM receipts WHERE service = ${provider.service} AND purpose = 'active_search' AND status = 'received' ORDER BY id`;
    for (const r of unstored) {
      let hits: SearchHit[];
      try {
        hits = provider.parse(r.response);
      } catch (error) {
        await rejectReceivedResponse(r.id, message(error));
        continue;
      }
      const meta = { lane: String(r.request?.lane ?? ""), query: String(r.request?.query ?? ""), depth: String(r.request?.searchDepth ?? "") };
      c.found += hits.length;
      c.imported += await storeHits(source.id, provider.name, meta, r.id, hits);
      c.recovered += 1;
    }

    const plan = await planQueries(day);
    model = plan.model;
    modelError = plan.modelError;
    c.planned = plan.queries.length;
    for (const q of plan.queries) {
      if (stopped) break;
      let result: SearchResult | null = null;
      // A request the provider clearly refused for now (429, 5xx, not connected) is tried once more; it counts again.
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        try {
          result = await provider.search(q, now);
        } catch (error) {
          if (shutdownSignal.signal.aborted) throw error;
          if (error instanceof ProviderRejectedError && error.retryable && attempt === 0) continue;
          // Over the quota: this one is skipped, a cheaper depth may still fit. An unknown or in-flight
          // request (ReceiptUnknownError, ReceiptBusyError) is left to ops.recover, not sent again here.
          if (error instanceof BudgetExceededError) c.limited += 1;
          else {
            c.failed += 1;
            if (errors.length < 5) errors.push(`${q.lane}: ${message(error)}`);
            if (error instanceof ProviderRejectedError && error.status !== null && ACCOUNT_REFUSALS.has(error.status)) stopped = `HTTP ${error.status}`;
          }
          break;
        }
      }
      if (!result) continue;
      if (result.reused) c.reused += 1;
      else c.searched += 1;
      c.found += result.hits.length;
      try {
        c.imported += await storeHits(source.id, provider.name, q, result.receiptId, result.hits);
      } catch (error) {
        if (shutdownSignal.signal.aborted) throw error;
        // The answer stays received: the next run stores it without paying again.
        c.failed += 1;
        if (errors.length < 5) errors.push(`${q.lane} store: ${message(error)}`);
      }
    }
  } catch (error) {
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), found_count = ${c.found}, new_count = ${c.imported}, error = ${message(error)} WHERE id = ${run!.id}`;
    throw error;
  }

  const usage = await provider.usage(sql, now);
  const detail = { provider: provider.name, day, model, ...(modelError ? { modelError } : {}), ...c, stopped, errors, usage };
  // Refused by the quota is no failure; a run where every request failed is.
  const ok = c.failed === 0 || c.searched + c.reused + c.recovered > 0;
  const lastError = ok ? null : errors[0] ?? "every search failed";
  await sql.begin(async (tx) => {
    if (ok) {
      await tx`UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL, health = 'ok', updated_at = now() WHERE id = ${source.id}`;
    } else {
      await tx`UPDATE sources SET last_fetch_at = now(), fail_count = fail_count + 1, last_error = ${lastError},
                 health = CASE WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END, updated_at = now() WHERE id = ${source.id}`;
    }
    await tx`UPDATE fetch_runs SET status = ${ok ? "ok" : "failed"}, finished_at = now(), found_count = ${c.found}, new_count = ${c.imported},
               detail = ${tx.json(detail as never)}, error = ${lastError} WHERE id = ${run!.id}`;
  });
  return detail;
}
