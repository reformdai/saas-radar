// Recent account listings (EveryInfra 万有引擎). A large limit is a ceiling, not a promised page size.
import { credential } from "../config.ts";
import type { Db } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import type { MpHistory, MpPost } from "./dajiala.ts";
import { BudgetExceededError, paidRequest, ProviderRejectedError, type CallOutcome } from "./receipts.ts";

export const EVERYINFRA_DEFAULT_BUDGET = { per_minute: 3, per_hour: 12, per_day: 48 };

/** Until an administrator saves a budget, the new service still has a circuit breaker. */
async function defaultBudget(tx: Db): Promise<void> {
  const [saved] = await tx`SELECT service FROM budgets WHERE service = 'everyinfra'`;
  if (saved) return; // paidRequest already checked the administrator's budget.
  const [used] = await tx<{ minute: number; hour: number; day: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > now() - interval '1 minute')::int AS minute,
           count(*) FILTER (WHERE started_at > now() - interval '1 hour')::int AS hour,
           count(*)::int AS day
    FROM receipt_attempts WHERE service = 'everyinfra' AND origin = 'live' AND started_at > now() - interval '1 day'`;
  if (used!.minute >= EVERYINFRA_DEFAULT_BUDGET.per_minute) throw new BudgetExceededError("everyinfra", "minute", 60);
  if (used!.hour >= EVERYINFRA_DEFAULT_BUDGET.per_hour) throw new BudgetExceededError("everyinfra", "hour", 3600);
  if (used!.day >= EVERYINFRA_DEFAULT_BUDGET.per_day) throw new BudgetExceededError("everyinfra", "day", 86400);
}

interface ListingResponse {
  results?: unknown;
  id?: string;
  billing?: { charged?: boolean; amount?: { base?: string; amount?: number } };
}

export function everyinfraCost(response: ListingResponse): CallOutcome["cost"] {
  const billing = response.billing;
  if (billing?.charged === false) return { amount: 0, currency: "USD", basis: "actual" };
  const amount = billing?.amount;
  return amount && typeof amount.amount === "number" && Number.isFinite(amount.amount) && amount.amount >= 0 && typeof amount.base === "string"
    ? { amount: amount.amount, currency: amount.base, basis: "actual" }
    : null;
}

/** Identity is the article URL (including idx/sn), not mid, which siblings can share. */
export function everyinfraPosts(response: ListingResponse): MpPost[] {
  if (!Array.isArray(response.results)) throw new Error("EveryInfra account_articles: missing results array");
  return response.results.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const r = value as Record<string, unknown>;
    if (r.is_deleted === true || typeof r.url !== "string" || typeof r.title !== "string" || !r.title.trim()) return [];
    let url: URL;
    try { url = new URL(r.url); } catch { return []; }
    if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "mp.weixin.qq.com") return [];
    const time = typeof r.posted_at === "string" ? Date.parse(r.posted_at) : NaN;
    return [{
      position: typeof r.position === "number" ? r.position : Number(url.searchParams.get("idx") || 1),
      url: r.url,
      title: r.title.trim(),
      post_time: Number.isFinite(time) ? Math.floor(time / 1000) : 0,
      sn: url.searchParams.get("sn") || undefined,
      cover_url: typeof r.cover_image_url === "string" ? r.cover_image_url : undefined,
      original: r.is_original === true ? 1 : 0,
    }];
  });
}

interface JobResponse extends ListingResponse {
  job_id?: string;
  status?: string;
  error?: { reason?: string; charged?: boolean | null };
}

/** An async job is paid at submission; polling is free. A job not finished in time stays unknown and is never resubmitted. */
async function awaitJob(jobId: string, key: string, deadlineMs: number): Promise<JobResponse> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const res = await guardedFetch(`https://api.everyinfra.com/api/v1/jobs/${encodeURIComponent(jobId)}`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024, redirectPolicy: "same-origin", route: "direct",
    });
    if (res.status >= 400) continue; // A failed poll says nothing about the job.
    const job = JSON.parse(res.text().split(key).join("[REDACTED]")) as JobResponse;
    if (job.status === "succeeded") return job;
    if (job.status === "failed") {
      throw new ProviderRejectedError(`EveryInfra job ${jobId} failed: ${job.error?.reason ?? "unknown"}${job.error?.charged === false ? " (refunded)" : ""}`, 502, false);
    }
  }
  throw new Error(`EveryInfra job ${jobId} not finished in time; listing outcome unknown`);
}

/**
 * The most recent articles (catalog limit 160, 175–199 observed); the provider has no paging beyond them.
 * Sync calls return a varying share (10 to 160 observed); `async` waits for the whole listing, for archiving.
 */
export async function everyinfraHistory(account: string, opts: { subject: string; window: string; async?: boolean }): Promise<MpHistory> {
  const key = credential("collectors", "EVERYINFRA_API_KEY");
  if (!key) throw new Error("EVERYINFRA_API_KEY is not configured");
  const receipt = await paidRequest({
    service: "everyinfra", purpose: "mp_history", subject: opts.subject,
    identity: { account, window: opts.window, limit: 160, ...(opts.async ? { mode: "async" } : {}) }, requestSummary: { account, limit: 160 }, guard: defaultBudget,
  }, async () => {
    const res = await guardedFetch("https://api.everyinfra.com/api/v1/social", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ platform: "wechat_oa", action: "account_articles", ...(opts.async ? { mode: "async" } : {}), params: { account, limit: 160 } }),
      timeoutMs: 100_000, maxBytes: 2 * 1024 * 1024, redirectPolicy: "same-origin", route: "direct",
    });
    // Do not include provider messages: they could echo credentials or request headers.
    if (res.status >= 400) throw new ProviderRejectedError(`EveryInfra HTTP ${res.status}${res.status === 402 ? ": insufficient quota" : ""}`, res.status, res.status === 429 || res.status === 503);
    const json = JSON.parse(res.text().split(key).join("[REDACTED]")) as JobResponse;
    if (opts.async && res.status === 202 && json.job_id) {
      const job = await awaitJob(json.job_id, key, 240_000);
      return { response: job, requestId: json.job_id, cost: everyinfraCost(json), usage: { posts: Array.isArray(job.results) ? job.results.length : 0 } };
    }
    // 202 means an accepted job, not a received listing. Keep the outcome unknown, never repeat it.
    if (res.status !== 200) throw new Error(`EveryInfra unexpected HTTP ${res.status}; listing outcome unknown`);
    return { response: json, requestId: json.id, cost: everyinfraCost(json), usage: { posts: Array.isArray(json.results) ? json.results.length : 0 } };
  });
  return { posts: everyinfraPosts(receipt.response as ListingResponse), nickname: null, remainMoney: null, receiptId: receipt.receiptId, reused: receipt.reused };
}
