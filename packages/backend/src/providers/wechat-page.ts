// WeChat article bodies read from the public article page itself (free, no key). Account listings
// still come from a paid provider; only the body moved here.
import * as cheerio from "cheerio";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";

/**
 * After a verification or throttling answer, no WeChat page is requested at all for this long. A block
 * can outlast it (seen: verification again on the first request an hour later), so another one within
 * a day of the last pause doubles the pause, up to a day.
 */
const COOLDOWN_MS = 3600_000;
const MAX_COOLDOWN_MS = 24 * 3600_000;
const PACE_KEY = "wechat_page_pace";

/**
 * Every WeChat page request, in any process, takes the next free slot: at least the configured interval
 * after the previous one. Too many requests from one address end in verification pages and, kept up,
 * a blocked address. A slot further away than `maxWaitMs` is not taken (a passing failure).
 */
async function pace(maxWaitMs: number): Promise<void> {
  const wait = await sql.begin(async (tx) => {
    await tx`INSERT INTO settings (key, value, updated_by) VALUES (${PACE_KEY}, '{}', 'system') ON CONFLICT (key) DO NOTHING`;
    const [row] = await tx<{ value: { nextAt?: string; coolUntil?: string } }[]>`SELECT value FROM settings WHERE key = ${PACE_KEY} FOR UPDATE`;
    const now = Date.now();
    const coolUntil = Date.parse(row!.value.coolUntil ?? "");
    if (coolUntil > now) throw new Error(`WeChat pages paused until ${new Date(coolUntil).toISOString()} after a verification page`);
    const at = Math.max(now, Date.parse(row!.value.nextAt ?? "") || 0);
    if (at - now > maxWaitMs) throw new Error("WeChat page queue is full; try again later");
    const interval = config.wechatPageIntervalSeconds * 1000 * (1 + Math.random() / 2);
    await tx`UPDATE settings SET value = value || ${tx.json({ nextAt: new Date(at + interval).toISOString() })}, updated_at = now() WHERE key = ${PACE_KEY}`;
    return at - now;
  });
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function coolDown(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO settings (key, value, updated_by) VALUES (${PACE_KEY}, '{}', 'system') ON CONFLICT (key) DO NOTHING`;
    const [row] = await tx<{ value: { coolUntil?: string; cooldownMs?: number } }[]>`SELECT value FROM settings WHERE key = ${PACE_KEY} FOR UPDATE`;
    const now = Date.now();
    const last = Date.parse(row!.value.coolUntil ?? "");
    if (last > now) return; // Already paused (a concurrent request saw the same block).
    const cooldownMs = now - last < MAX_COOLDOWN_MS ? Math.min((row!.value.cooldownMs ?? COOLDOWN_MS / 2) * 2, MAX_COOLDOWN_MS) : COOLDOWN_MS;
    await tx`UPDATE settings SET value = value || ${tx.json({ coolUntil: new Date(now + cooldownMs).toISOString(), cooldownMs })}, updated_at = now() WHERE key = ${PACE_KEY}`;
  });
}

export interface WechatPage {
  title: string;
  /** Inner HTML of #js_content; empty when the article is deleted, blocked or not a text post. */
  content: string;
  author: string | null;
  desc: string | null;
  /** Unix seconds from the page script, when present. */
  publishedAt: number | null;
  /** A repost shows only a card linking to the original ("阅读全文"); its link, when the body is empty. */
  sharedFrom: string | null;
}

/**
 * Throws for passing failures (network, server error, verification page); unavailable articles return
 * empty content. A repost takes the original's body, followed once.
 */
export async function fetchWechatPage(articleUrl: string, opts: { maxWaitMs?: number } = {}): Promise<WechatPage> {
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const page = await fetchOne(articleUrl, maxWaitMs);
  if (page.content || !page.sharedFrom) return page;
  return { ...page, content: (await fetchOne(page.sharedFrom, maxWaitMs)).content };
}

async function fetchOne(articleUrl: string, maxWaitMs: number): Promise<WechatPage> {
  const url = new URL(articleUrl);
  if (url.hostname !== "mp.weixin.qq.com") throw new Error("not a WeChat article URL");
  url.protocol = "https:"; // Listings often carry http:// links.
  await pace(maxWaitMs);
  const res = await guardedFetch(url.toString(), {
    headers: { accept: "text/html", referer: "https://mp.weixin.qq.com/" },
    timeoutMs: 30_000,
    maxBytes: 8 * 1024 * 1024,
  });
  if (res.status === 403 || res.status === 429) await coolDown();
  if (res.status >= 400) throw new Error(`WeChat page HTTP ${res.status}`);
  try {
    return parseWechatPage(res.text(), res.url);
  } catch (error) {
    await coolDown(); // Only verification pages throw here.
    throw error;
  }
}

export function parseWechatPage(html: string, finalUrl = ""): WechatPage {
  const $ = cheerio.load(html);
  const body = $("#js_content");
  // Anti-crawl answers with a captcha page ("环境异常") or, under lighter throttling, "未知错误，请稍后再试";
  // both pass, so they must never look like a missing body.
  if (!body.length && (/wappoc_appmsgcaptcha|secitptpage\/verify/.test(finalUrl) || /环境异常|未知错误/.test(html))) {
    throw new Error("WeChat verification page (rate limited)");
  }
  const meta = (selector: string) => $(selector).attr("content")?.trim() || null;
  const ct = /var\s+ct\s*=\s*"(\d+)"/.exec(html)?.[1];
  return {
    title: meta('meta[property="og:title"]') ?? $("#activity-name").text().trim(),
    content: body.html()?.trim() ?? "",
    author: meta('meta[name="author"]') ?? ($("#js_name").text().trim() || null),
    desc: meta('meta[property="og:description"]') ?? meta('meta[name="description"]'),
    publishedAt: ct ? Number(ct) : null,
    sharedFrom: body.html()?.trim() ? null : $("#js_share_source").attr("data-url") || null,
  };
}
