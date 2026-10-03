// 今日发现 (publication/discoveries.ts): listed (public, eligible, released) items newest discovery
// first, selected or not, old material included and labelled by how it arrived, stable keyset pages,
// what was fetched of the original, and the open question apart from the reason. Fixtures are
// discovered in 2098 so they lead the list whatever else the shared test database holds.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { encodeCursor, queryBinding } from "@aihot/backend/lib/cursor";
import { loadDiscoveries } from "@aihot/backend/publication/discoveries";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const SOURCE = `discoveries-${T}`;
const BASE = Date.parse("2098-06-01T00:00:00Z");
const PAST = new Date(Date.now() - 3_600_000);
const app = await buildApp();
const ids: string[] = [];

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${SOURCE}, 'Discoveries fixture', 'rss', 'T2', 'editorial', '2100-01-01')`;
});
after(async () => {
  await app.close();
  if (ids.length) {
    await sql`DELETE FROM publications WHERE article_id IN ${sql(ids)}`;
    await sql`DELETE FROM analyses WHERE article_id IN ${sql(ids)}`;
    await sql`DELETE FROM articles WHERE id IN ${sql(ids)}`;
  }
  await sql`DELETE FROM sources WHERE id = ${SOURCE}`;
  await closeDb();
});

interface Fixture {
  minute: number;
  category?: "growth" | "products";
  selected?: boolean;
  eligible?: boolean;
  visibility?: string;
  visibleAfter?: Date;
  publishedAt?: Date | null;
  backfillReason?: string | null;
  bodyStatus?: string;
  body?: string | null;
  excerpt?: string | null;
  question?: string;
  raw?: Record<string, unknown>;
}

async function item(name: string, f: Fixture): Promise<string> {
  const id = `${T}-${name}`;
  ids.push(id);
  const discovered = new Date(BASE + f.minute * 60_000);
  const published = f.publishedAt === undefined ? discovered : f.publishedAt;
  const backfill = f.backfillReason !== undefined && f.backfillReason !== null;
  const timeline = backfill && published ? published : discovered;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at, backfill, backfill_reason, body_status, body_text, excerpt, raw)
    VALUES (${id}, ${SOURCE}, ${id}, ${`https://example.test/${id}`}, ${id}, ${published}, ${discovered}, ${timeline}, ${backfill}, ${f.backfillReason ?? null},
      ${f.bodyStatus ?? "ok"}, ${f.body === undefined ? "Full body text." : f.body}, ${f.excerpt === undefined ? "Feed summary." : f.excerpt},
      ${f.raw ? sql.json(f.raw as never) : null})`;
  const [analysis] = await sql<{ id: number }[]>`
    INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected, output)
    VALUES (${id}, 1, 'rule', 'pass', ${f.category ?? "growth"}, ${`标题 ${name}`}, '摘要', '理由', 80, ${f.selected ?? true}, ${sql.json(f.question ? { researchQuestion: f.question } : {})})
    RETURNING id`;
  const selected = f.selected ?? true;
  await sql`INSERT INTO publications (article_id, analysis_id, title, summary, reason, category, source_id, channel, url, published_at, discovered_at, timeline_at, sort_at,
      backfill, eligible, selected, selected_ready_at, visible_after, visibility, tags)
    VALUES (${id}, ${analysis!.id}, ${`标题 ${name}`}, '摘要', ${selected ? "理由" : null}, ${f.category ?? "growth"}, ${SOURCE}, 'news', ${`https://example.test/${id}`}, ${published},
      ${discovered}, ${timeline}, ${timeline}, ${backfill}, ${f.eligible ?? true}, ${selected}, ${selected ? PAST : null}, ${selected ? (f.visibleAfter ?? PAST) : null},
      ${f.visibility ?? "public"}, ${[]})`;
  return id;
}

/** The fixture ids among a page, in order. */
const mine = (items: Array<{ id: string }>) => items.map((i) => i.id).filter((id) => ids.includes(id));

test("listed items lead by discovery time, selected or not; old material keeps its source time and says how it arrived", async () => {
  const twoYearsAgo = new Date(BASE - 2 * 365 * 86_400_000);
  const live = await item("live", { minute: 10, question: "  作者的收入是毛收入还是净收入？  " });
  const imported = await item("imported", { minute: 20, publishedAt: twoYearsAgo, backfillReason: "first-import" });
  const late = await item("late", { minute: 30, publishedAt: new Date(BASE - 10 * 86_400_000), backfillReason: "stale-on-discovery" });
  const unselected = await item("unselected", { minute: 40, selected: false, question: "  他说的留存率怎么算？  " });
  await item("withdrawn", { minute: 50, visibility: "withdrawn" });
  await item("withdrawn-unselected", { minute: 51, selected: false, visibility: "withdrawn", question: "撤回后不应出现？" });
  await item("summary-only", { minute: 52, selected: false, visibility: "summary-only", question: "非公开不应出现？" });
  await item("ineligible", { minute: 53, selected: false, eligible: false });
  const archived = await item("archived", { minute: 54, selected: false, publishedAt: new Date(BASE - 400 * 86_400_000), backfillReason: "backfill" });
  const gate = new Date(BASE + 90 * 60_000);
  const gated = await item("gated", { minute: 60, visibleAfter: gate });

  const now = new Date(BASE + 61 * 60_000);
  const page = await loadDiscoveries({ now, limit: 40 });
  assert.deepEqual(mine(page.items), [archived, unselected, late, imported, live],
    "newest discovery first, unselected and backfilled material included; withdrawn, non-public, ineligible and gated items stay out");
  assert.equal(page.refreshAt, gate.toISOString(), "the page expires when the gated item opens");

  const byId = new Map(page.items.map((i) => [i.id, i]));
  assert.deepEqual([byId.get(live)!.arrival, byId.get(imported)!.arrival, byId.get(late)!.arrival], ["live", "first-import", "late"]);
  assert.equal(byId.get(imported)!.publishedAt, twoYearsAgo.toISOString(), "the original's time, not the import time");
  assert.equal(byId.get(imported)!.discoveredAt, new Date(BASE + 20 * 60_000).toISOString());
  assert.equal(byId.get(live)!.researchQuestion, "作者的收入是毛收入还是净收入？");
  assert.equal(byId.get(live)!.reason, "理由", "the reason stays its own field");
  assert.equal(byId.get(imported)!.researchQuestion, null);
  assert.equal(byId.get(live)!.originalUrl, `https://example.test/${live}`);
  assert.equal(byId.get(live)!.selected, true);

  const plain = byId.get(unselected)!;
  assert.deepEqual([plain.selected, plain.reason], [false, null], "an unselected item carries no reason");
  assert.equal(plain.researchQuestion, "他说的留存率怎么算？", "its open question is a lead for the reader, kept whether or not it was selected");
  assert.equal(plain.summary, "摘要");
  assert.deepEqual([byId.get(archived)!.arrival, byId.get(archived)!.selected], ["backfill", false]);

  const opened = await loadDiscoveries({ now: new Date(gate.getTime() + 1), limit: 40 });
  assert.deepEqual(mine(opened.items), [gated, archived, unselected, late, imported, live], "a gated item appears at its discovery place once released");
});

test("the material status follows what was stored, not the source's licence", async () => {
  const body = await item("body", { minute: 100 });
  const summary = await item("summary", { minute: 101, bodyStatus: "pending", body: null });
  const failed = await item("failed", { minute: 102, bodyStatus: "unconfirmed", body: null });
  const bare = await item("bare", { minute: 103, bodyStatus: "none", body: null, excerpt: null });
  const page = await loadDiscoveries({ now: new Date(BASE + 200 * 60_000), limit: 40 });
  const status = new Map(page.items.map((i) => [i.id, i.material]));
  assert.deepEqual([body, summary, failed, bare].map((id) => status.get(id)), ["body", "excerpt", "excerpt", "title"]);
});

test("material the site's own search found carries its provider and query; other material carries none", async () => {
  const query = `reddit r/SaaS annual plan discount churn ${"x".repeat(300)}`;
  const searched = await item("searched", { minute: 150, raw: { search: { provider: "tavily", query: `  ${query}  `, lane: "reddit", depth: "basic" } } });
  const late = await item("searched-late", { minute: 151, publishedAt: new Date(BASE - 10 * 86_400_000), backfillReason: "stale-on-discovery",
    raw: { search: { provider: "tavily", query: "old founder post" } } });
  const broken = await item("searched-broken", { minute: 152, raw: { search: "not an object" } });
  const plain = await item("not-searched", { minute: 153, raw: { feed: "rss" } });
  const page = await loadDiscoveries({ now: new Date(BASE + 200 * 60_000), limit: 40 });
  const byId = new Map(page.items.map((i) => [i.id, i]));
  assert.deepEqual(byId.get(searched)!.search, { provider: "tavily", query: query.slice(0, 200) }, "trimmed and capped");
  assert.equal(byId.get(searched)!.arrival, "live", "a search is evidence, not an arrival of its own");
  assert.deepEqual([byId.get(late)!.arrival, byId.get(late)!.search?.query], ["late", "old founder post"], "the timeline rule still says it is old");
  assert.equal(byId.get(broken)!.search, null);
  assert.equal(byId.get(plain)!.search, null);
});

test("keyset pages neither repeat nor skip items that share a discovery time", async () => {
  const same = [await item("tie-a", { minute: 300 }), await item("tie-b", { minute: 300 }), await item("tie-c", { minute: 300 })];
  const older = await item("tie-older", { minute: 299 });
  const now = new Date(BASE + 400 * 60_000);
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 5; i++) {
    const page: Awaited<ReturnType<typeof loadDiscoveries>> = await loadDiscoveries({ now, limit: 2, cursor });
    seen.push(...page.items.map((x) => x.id));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  const expected = [...same].sort().reverse().concat(older);
  assert.deepEqual(seen.slice(0, 4), expected, "ties break by id, descending");
  assert.equal(new Set(seen).size, seen.length, "no item on two pages");
});

test("the site route serves the list and refuses a malformed cursor", async () => {
  const id = await item("route", { minute: 500, question: "需求是否普遍？" });
  const res = await app.inject({ method: "GET", url: "/api/site/discoveries?limit=5" });
  assert.equal(res.statusCode, 200);
  const first = res.json().items[0];
  assert.deepEqual([first.id, first.material, first.arrival, first.researchQuestion], [id, "body", "live", "需求是否普遍？"]);
  assert.equal((await app.inject({ method: "GET", url: "/api/site/discoveries?cursor=nope" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: `/api/site/discoveries?cursor=dc1.${Buffer.from("[]").toString("base64url")}` })).statusCode, 400);
});

test("the site route takes a whole-number limit, defaults to 20 and refuses any other", async () => {
  for (let i = 0; i < 41; i++) await item(`limit-${i}`, { minute: 800 + i, category: "products" });
  const count = async (query: string) => {
    const res = await app.inject({ method: "GET", url: `/api/site/discoveries${query}` });
    assert.equal(res.statusCode, 200, query);
    return res.json().items.length as number;
  };
  assert.equal(await count(""), 20);
  assert.equal(await count("?limit=3"), 3);
  assert.equal(await count("?limit=-5"), 1, "below the range is the minimum");
  assert.equal(await count("?limit=100"), 40, "above the range is the maximum");
  for (const limit of ["1.5", "abc", "Infinity", "1e400", "NaN"]) {
    const res = await app.inject({ method: "GET", url: `/api/site/discoveries?limit=${limit}` });
    assert.equal(res.statusCode, 400, limit);
    assert.equal(res.json().code, "invalid_request");
  }
  const direct = await loadDiscoveries({ now: new Date(BASE + 900 * 60_000), limit: 1.5 });
  assert.equal(direct.items.length, 20, "a direct caller's fraction falls back to the default instead of reaching SQL");
});

test("category filtering applies before pagination and rejects another category's cursor", async () => {
  await item("category-product", { minute: 602, category: "products", selected: false });
  const newer = await item("category-growth-new", { minute: 601 });
  const older = await item("category-growth-old", { minute: 600, selected: false });
  const now = new Date(BASE + 700 * 60_000);
  const first = await loadDiscoveries({ category: "growth", limit: 1, now });
  assert.equal(first.items[0]!.id, newer);
  assert.ok(first.nextCursor);
  const second = await loadDiscoveries({ category: "growth", limit: 1, now, cursor: first.nextCursor });
  assert.equal(second.items[0]!.id, older);
  const url = `/api/site/discoveries?category=products&cursor=${encodeURIComponent(first.nextCursor!)}`;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/site/discoveries?category=invalid" })).statusCode, 400);
  const cursor = encodeCursor("dc1", { d: Number.MAX_SAFE_INTEGER, i: newer, b: queryBinding({ k: null }) });
  assert.equal((await app.inject({ method: "GET", url: `/api/site/discoveries?cursor=${cursor}` })).statusCode, 400);
});
