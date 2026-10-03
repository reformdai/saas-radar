// Tavily Search (https://docs.tavily.com/documentation/api-reference/endpoint/search): the active search's
// provider. Paid in credits (basic 1, advanced 2), always behind receipts. The calendar quotas of
// industry/search.ts are checked by the receipt's guard under the service's budget lock, over every
// attempt of the Beijing day and month (failed and retried ones included), so no run can overshoot them.
// Only the fixed parameters below are sent: no auto parameters, answers or raw page content.
import { SEARCH_MAX_RESULTS, SEARCH_QUOTA } from "@aihot/industry/search";
import { credential } from "../config.ts";
import type { Db } from "../db.ts";
import { guardedFetch, type GuardedResponse } from "../lib/http-fetch.ts";
import { normalizeUrl } from "../lib/url.ts";
import { isConnectFailure } from "./llm.ts";
import { BudgetExceededError, paidRequest, ProviderRejectedError, rejectReceivedResponse } from "./receipts.ts";

export type SearchDepth = "basic" | "advanced";

export const SEARCH_CREDITS: Record<SearchDepth, number> = { basic: 1, advanced: 2 };

/** One search result: a lead to the original, its snippet only a summary (never the body). */
export interface SearchHit {
  url: string;
  title: string;
  content: string | null;
  publishedAt: Date | null;
}

export interface SearchResult {
  receiptId: number;
  reused: boolean;
  hits: SearchHit[];
}

const HOUR_MS = 3600_000;
const BEIJING_MS = 8 * HOUR_MS;

/** The Beijing calendar day (YYYY-MM-DD) of a moment. */
export function beijingDay(now: Date): string {
  return new Date(now.getTime() + BEIJING_MS).toISOString().slice(0, 10);
}

/** Starts of the Beijing day and month around `now`, and of the next ones. */
function windows(now: Date) {
  const bj = new Date(now.getTime() + BEIJING_MS);
  const [y, m, d] = [bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()];
  return {
    dayStart: new Date(Date.UTC(y, m, d) - BEIJING_MS),
    nextDay: new Date(Date.UTC(y, m, d + 1) - BEIJING_MS),
    monthStart: new Date(Date.UTC(y, m, 1) - BEIJING_MS),
    nextMonth: new Date(Date.UTC(y, m + 1, 1) - BEIJING_MS),
  };
}

export interface TavilyUsage {
  /** Attempts sent this Beijing day, by depth. */
  basic: number;
  advanced: number;
  /** Credits this Beijing month: each attempt at least its depth's price, more when Tavily reported more. */
  monthCredits: number;
}

/** Every live attempt counts, whatever became of it: a failed or unknown request may still have been billed. */
export async function tavilyUsage(db: Db, now = new Date()): Promise<TavilyUsage> {
  const w = windows(now);
  const [u] = await db<{ basic: number; advanced: number; credits: number }[]>`
    SELECT
      count(*) FILTER (WHERE t.started_at >= ${w.dayStart} AND r.request->>'searchDepth' = 'basic')::int AS basic,
      count(*) FILTER (WHERE t.started_at >= ${w.dayStart} AND r.request->>'searchDepth' = 'advanced')::int AS advanced,
      coalesce(sum(greatest(
        CASE WHEN r.request->>'searchDepth' = 'advanced' THEN 2 ELSE 1 END,
        CASE WHEN jsonb_typeof(t.usage->'credits') = 'number' THEN (t.usage->>'credits')::float8 ELSE 0 END
      )), 0)::float8 AS credits
    FROM receipt_attempts t JOIN receipts r ON r.id = t.receipt_id
    WHERE t.service = 'tavily' AND t.origin = 'live' AND t.started_at >= ${w.monthStart}`;
  return { basic: u!.basic, advanced: u!.advanced, monthCredits: u!.credits };
}

async function checkQuota(tx: Db, depth: SearchDepth, now: Date): Promise<void> {
  const w = windows(now);
  const u = await tavilyUsage(tx, now);
  const untilDay = Math.ceil((w.nextDay.getTime() - now.getTime()) / 1000);
  if (depth === "basic" && u.basic >= SEARCH_QUOTA.basicPerDay) throw new BudgetExceededError("tavily", "basic searches per Beijing day", untilDay);
  if (depth === "advanced" && u.advanced >= SEARCH_QUOTA.advancedPerDay) throw new BudgetExceededError("tavily", "advanced searches per Beijing day", untilDay);
  if (u.monthCredits + SEARCH_CREDITS[depth] > SEARCH_QUOTA.creditsPerMonth) {
    throw new BudgetExceededError("tavily", "credits per Beijing month", Math.ceil((w.nextMonth.getTime() - now.getTime()) / 1000));
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The usable results of a stored response; throws when it carries no result list at all. */
export function parseTavilyResponse(response: unknown): SearchHit[] {
  const results = (response as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new Error("Tavily response has no results list");
  const hits: SearchHit[] = [];
  for (const r of results as Array<Record<string, unknown>>) {
    let url: string | null = null;
    try {
      url = text(r?.url) ? normalizeUrl(text(r.url)!) : null;
    } catch {
      url = null;
    }
    if (!url) continue;
    const date = text(r.published_date) ? new Date(text(r.published_date)!) : null;
    hits.push({
      url,
      title: text(r.title) ?? url,
      content: text(r.content)?.slice(0, 2000) ?? null,
      publishedAt: date && Number.isFinite(date.getTime()) ? date : null,
    });
  }
  return hits.slice(0, SEARCH_MAX_RESULTS);
}

/**
 * One search. The receipt key is the Beijing day, query and depth: a same-day re-run reuses the
 * answer (received or completed) instead of paying again. The caller stores the hits and completes the receipt.
 */
export async function tavilySearch(query: string, opts: { depth: SearchDepth; lane: string; now?: Date }): Promise<SearchResult> {
  const key = credential("collectors", "TAVILY_API_KEY");
  if (!key) throw new Error("TAVILY_API_KEY is not configured");
  const base = (credential("collectors", "TAVILY_BASE_URL") ?? "https://api.tavily.com").replace(/\/$/, "");
  const now = opts.now ?? new Date();
  const day = beijingDay(now);
  const params = {
    query,
    search_depth: opts.depth,
    max_results: SEARCH_MAX_RESULTS,
    auto_parameters: false,
    include_answer: false,
    include_raw_content: false,
    include_usage: true,
  };
  const receipt = await paidRequest(
    {
      service: "tavily",
      model: null,
      purpose: "active_search",
      subject: `search:${day}`,
      identity: { day, params },
      requestSummary: { provider: "tavily", query, searchDepth: opts.depth, lane: opts.lane, day },
      guard: (tx) => checkQuota(tx, opts.depth, now),
    },
    async () => {
      let res: GuardedResponse;
      try {
        res = await guardedFetch(`${base}/search`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(params),
          timeoutMs: 60_000,
          maxBytes: 2 * 1024 * 1024,
        });
      } catch (error) {
        // Not connected: the request never left, so it may be sent again (it still counts as an attempt).
        if (isConnectFailure(error)) throw new ProviderRejectedError(`tavily connect failed: ${String(error)}`, null, true);
        throw error;
      }
      if (res.status === 429 || res.status >= 500) throw new ProviderRejectedError(`tavily HTTP ${res.status}`, res.status, true);
      if (res.status !== 200) throw new ProviderRejectedError(`tavily HTTP ${res.status}: ${res.text().slice(0, 300)}`, res.status, false);
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(res.text());
      } catch {
        json = { unparsable: res.text().slice(0, 20000) };
      }
      const reported = Number((json.usage as { credits?: unknown } | undefined)?.credits);
      const credits = Number.isFinite(reported) && reported >= 0 ? reported : null;
      return {
        response: json,
        requestId: typeof json.request_id === "string" ? json.request_id : res.headers.get("x-request-id"),
        usage: { credits },
        cost: credits !== null ? { amount: credits, currency: "credit", basis: "actual" } : { amount: SEARCH_CREDITS[opts.depth], currency: "credit", basis: "estimated" },
      };
    },
  );
  let hits: SearchHit[];
  try {
    hits = parseTavilyResponse(receipt.response);
  } catch (error) {
    // An unusable answer is not kept: the next attempt (within the quota) asks again.
    await rejectReceivedResponse(receipt.receiptId, String(error));
    throw error;
  }
  return { receiptId: receipt.receiptId, reused: receipt.reused, hits };
}
