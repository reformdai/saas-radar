// Active search (sources/search.ts, providers/tavily.ts) against local stand-ins for Tavily and the
// model: it stays off without its switch, key or collection; it sends the fixed parameters with a
// Bearer key; the Beijing day's 16 basic and 4 advanced searches and the month's 900 credits are hard
// limits over every attempt (failed and retried ones too); a same-day re-run pays nothing; an answer
// received but not stored is stored later without paying; results enter as leads (snippet as summary,
// body still to fetch, the usual timeline rule) and never take over material already stored.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { SEARCH_LANES } from "@aihot/industry/search";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { composePlan, runActiveSearch } from "@aihot/backend/sources/search";

const T = tag();
const SOURCE = "tavily-search";
const OTHER = `search-other-${T}`;
const TEMPLATES = new Set(SEARCH_LANES.flatMap((l) => l.templates));
const FRESH_DATE = new Date(Date.now() - 3_600_000).toISOString();
const OLD_DATE = new Date(Date.now() - 10 * 86_400_000).toISOString();

let round = 0;
let mode: "ok" | "unavailable" | "unauthorized" = "ok";
const requests: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];
const slug = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const fresh = (q: string) => `https://example.org/fresh/${T}/${round}/${slug(q)}`;
const undated = (q: string) => `https://example.org/undated/${T}/${round}/${slug(q)}`;
const shared = () => `https://example.org/shared/${T}/${round}`;
const existing = () => `https://example.org/existing/${T}/${round}`;

const tavily = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push({ path: req.url ?? "", auth: req.headers.authorization, body });
    res.setHeader("content-type", "application/json");
    if (mode === "unavailable") return void res.writeHead(503).end("{}");
    if (mode === "unauthorized") return void res.writeHead(401).end(JSON.stringify({ detail: { error: "Unauthorized" } }));
    const q = String(body.query);
    res.end(JSON.stringify({
      query: q,
      results: [
        { url: `${fresh(q)}?utm_source=tavily`, title: `Fresh: ${q}`, content: `Snippet for ${q}`, score: 0.91, published_date: FRESH_DATE },
        { url: undated(q), title: `Undated: ${q}`, content: `Undated snippet for ${q}`, score: 0.5 },
        { url: shared(), title: `Shared via ${q}`, content: "Shared snippet", score: 0.4, published_date: OLD_DATE },
        { url: existing(), title: "Search title that must not win", content: "Search snippet that must not win", score: 0.3 },
      ],
      usage: { credits: body.search_depth === "advanced" ? 2 : 1 },
      request_id: `req-${requests.length}`,
    }));
  });
});
await new Promise<void>((resolve) => tavily.listen(0, "127.0.0.1", () => resolve()));

let llmHits = 0;
let modelQueries: Array<{ lane: string; query: string }> = [];
const llm = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    llmHits += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: `chat-${llmHits}`, choices: [{ message: { content: JSON.stringify({ queries: modelQueries }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
});
await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", () => resolve()));

const saved = { privateFetch: config.allowPrivateNetworkFetch, modelCalls: config.modelCallsEnabled, collect: process.env.COLLECT_ENABLED };
let savedBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;

before(async () => {
  process.env.TAVILY_BASE_URL = `http://127.0.0.1:${(tavily.address() as { port: number }).port}`;
  process.env.TAVILY_API_KEY = "test-tavily-key";
  process.env.TAVILY_SEARCH_ENABLED = "true";
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${(llm.address() as { port: number }).port}`;
  process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
  delete process.env.COLLECT_ENABLED;
  config.allowPrivateNetworkFetch = true;
  config.modelCallsEnabled = false;
  [savedBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'deepseek'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 1000, per_day = 100000 WHERE service = 'deepseek'`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES (${OTHER}, 'Other source', 'rss', 'T2', 'editorial', '2100-01-01')`;
});

after(async () => {
  await reset();
  if (savedBudget) await sql`UPDATE budgets SET per_minute = ${savedBudget.per_minute}, per_hour = ${savedBudget.per_hour}, per_day = ${savedBudget.per_day} WHERE service = 'deepseek'`;
  config.allowPrivateNetworkFetch = saved.privateFetch;
  config.modelCallsEnabled = saved.modelCalls;
  if (saved.collect === undefined) delete process.env.COLLECT_ENABLED;
  else process.env.COLLECT_ENABLED = saved.collect;
  for (const name of ["TAVILY_BASE_URL", "TAVILY_API_KEY", "TAVILY_SEARCH_ENABLED", "SEARCH_MODEL"]) delete process.env[name];
  tavily.close();
  llm.close();
  await stopBoss();
  await closeDb();
});

/** A clean quota and fresh result addresses for the next test. */
async function reset() {
  await sql`DELETE FROM receipts WHERE service = 'tavily' OR purpose = 'search_queries'`;
  requests.length = 0;
  mode = "ok";
  round += 1;
}

/** Earlier attempts of the day (or month), as left behind by other runs. */
async function seed(depth: "basic" | "advanced", count: number, opts: { credits?: number; daysAgo?: number } = {}) {
  for (let i = 0; i < count; i++) {
    const [r] = await sql<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, purpose, subject, status, request, attempts)
      VALUES (${`tavily:seed:${T}:${round}:${depth}:${opts.daysAgo ?? 0}:${i}`}, 'tavily', 'active_search', 'seed', 'failed', ${sql.json({ searchDepth: depth })}, 1)
      RETURNING id`;
    await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, usage, started_at)
              VALUES (${r!.id}, 1, 'tavily', 'failed', ${opts.credits === undefined ? null : sql.json({ credits: opts.credits })},
                      ${new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000)})`;
  }
}

const depths = () => requests.map((r) => r.body.search_depth);
const count = (values: unknown[], v: unknown) => values.filter((x) => x === v).length;

test("the plan fills each lane, searches 16 basic and 4 advanced, and lets templates cover what the model did not write", () => {
  const plan = composePlan("2026-10-03", []);
  assert.equal(plan.length, 20);
  assert.equal(count(plan.map((q) => q.depth), "basic"), 16);
  assert.equal(count(plan.map((q) => q.depth), "advanced"), 4);
  for (const lane of SEARCH_LANES) {
    const mine = plan.filter((q) => q.lane === lane.lane);
    assert.equal(mine.length, lane.total, lane.lane);
    assert.equal(mine[0]!.depth, "advanced", "each lane opens with its deeper search");
  }
  assert.equal(new Set(plan.map((q) => q.query)).size, 20, "no query twice a day");
  assert.ok(plan.every((q) => q.origin === "template" && TEMPLATES.has(q.query)));
  assert.notEqual(composePlan("2026-10-04", [])[0]!.query, plan[0]!.query, "templates rotate by date");

  const reddit = SEARCH_LANES.find((l) => l.lane === "reddit")!;
  const mixed = composePlan("2026-10-03", [
    { lane: "reddit", query: "reddit r/SaaS annual plan discount churn" },
    { lane: "reddit", query: plan[0]!.query },
    { lane: "nowhere", query: "an unknown lane is ignored" },
  ]);
  const lane = mixed.filter((q) => q.lane === "reddit");
  assert.equal(lane.length, reddit.total);
  assert.deepEqual(lane.filter((q) => q.origin === "model").map((q) => q.query), ["reddit r/SaaS annual plan discount churn"], "duplicates and unknown lanes are dropped");
  assert.equal(mixed.length, 20);
});

test("it stays off without its switch, its key or collection", async () => {
  await reset();
  process.env.TAVILY_SEARCH_ENABLED = "false";
  assert.match(String((await runActiveSearch()).skipped), /disabled/);
  process.env.TAVILY_SEARCH_ENABLED = "true";
  delete process.env.TAVILY_API_KEY;
  assert.match(String((await runActiveSearch()).skipped), /no key/);
  process.env.TAVILY_API_KEY = "test-tavily-key";
  process.env.COLLECT_ENABLED = "false";
  assert.match(String((await runActiveSearch()).skipped), /COLLECT_ENABLED/);
  delete process.env.COLLECT_ENABLED;
  assert.equal(requests.length, 0);
});

test("a day's run sends the fixed parameters and stores results as leads beside existing material", async () => {
  await reset();
  // Already stored by another source, with its own body: the search only adds a discovery.
  const prior = await upsertMaterial({ sourceId: OTHER, url: existing(), title: "Original title", bodyText: "Original body from the source.", via: "fetch" });

  const run = await runActiveSearch();
  assert.equal(run.model, "failed", "model calls are off: the templates carry the day");
  assert.deepEqual([run.planned, run.searched, run.reused, run.failed, run.limited], [20, 20, 0, 0, 0]);
  assert.equal(requests.length, 20);
  for (const r of requests) {
    assert.equal(r.path, "/search");
    assert.equal(r.auth, "Bearer test-tavily-key");
    assert.deepEqual(Object.keys(r.body).sort(), ["auto_parameters", "include_answer", "include_raw_content", "include_usage", "max_results", "query", "search_depth"]);
    assert.deepEqual([r.body.max_results, r.body.auto_parameters, r.body.include_answer, r.body.include_raw_content, r.body.include_usage], [5, false, false, false, true]);
    assert.ok(TEMPLATES.has(String(r.body.query)));
  }
  assert.deepEqual([count(depths(), "basic"), count(depths(), "advanced")], [16, 4]);
  assert.deepEqual(run.usage, { basic: 16, advanced: 4, monthCredits: 24 });

  const first = requests[0]!.body;
  const [lead] = await sql<{ source_id: string; excerpt: string; body_text: string | null; body_status: string; published_at: Date | null; backfill: boolean; raw: { search: unknown }; processing_queued_at: Date | null }[]>`
    SELECT source_id, excerpt, body_text, body_status, published_at, backfill, raw, processing_queued_at FROM articles WHERE url = ${fresh(String(first.query))}`;
  assert.equal(lead!.source_id, SOURCE);
  assert.equal(lead!.excerpt, `Snippet for ${first.query}`, "the snippet is the summary");
  assert.deepEqual([lead!.body_text, lead!.body_status], [null, "pending"], "the body is still to fetch");
  assert.equal(lead!.published_at!.toISOString(), FRESH_DATE);
  assert.equal(lead!.backfill, false);
  assert.deepEqual(lead!.raw.search, { provider: "tavily", query: first.query, lane: "reddit", depth: "advanced" });
  assert.ok(lead!.processing_queued_at, "queued for extraction and analysis");

  const [plain] = await sql<{ published_at: Date | null; backfill: boolean }[]>`SELECT published_at, backfill FROM articles WHERE url = ${undated(String(first.query))}`;
  assert.deepEqual([plain!.published_at, plain!.backfill], [null, false], "no date given, none invented");
  const sharedRows = await sql<{ backfill_reason: string | null }[]>`SELECT backfill_reason FROM articles WHERE url = ${shared()}`;
  assert.equal(sharedRows.length, 1, "a URL found by many queries is one article");
  assert.equal(sharedRows[0]!.backfill_reason, "stale-on-discovery", "the usual timeline rule, no blanket search backfill");

  const [kept] = await sql<{ source_id: string; title: string; body_text: string; excerpt: string | null; revision: number }[]>`
    SELECT source_id, title, body_text, excerpt, revision FROM articles WHERE id = ${prior.articleId}`;
  assert.deepEqual([kept!.source_id, kept!.title, kept!.body_text, kept!.excerpt, kept!.revision], [OTHER, "Original title", "Original body from the source.", null, 1]);
  const discoveries = await sql`SELECT 1 FROM article_discoveries WHERE article_id = ${prior.articleId} AND source_id = ${SOURCE}`;
  assert.equal(discoveries.length, 1, "the search's finding is recorded as a discovery");

  const receipts = await sql<{ status: string; cost: number; cost_basis: string; request: { searchDepth: string } }[]>`
    SELECT status, cost, cost_basis, request FROM receipts WHERE service = 'tavily'`;
  assert.equal(receipts.length, 20);
  assert.ok(receipts.every((r) => r.status === "completed" && r.cost_basis === "actual" && r.cost === (r.request.searchDepth === "advanced" ? 2 : 1)));

  const [source] = await sql<{ kind: string; participation_mode: string; config: Record<string, unknown>; health: string; site_fulltext: boolean }[]>`
    SELECT kind, participation_mode, config, health, site_fulltext FROM sources WHERE id = ${SOURCE}`;
  assert.deepEqual([source!.kind, source!.participation_mode, source!.config.fetchPublicContent, source!.health, source!.site_fulltext], ["external", "editorial", true, "ok", false]);
  const [fetchRun] = await sql<{ status: string; new_count: number }[]>`SELECT status, new_count FROM fetch_runs WHERE source_id = ${SOURCE} ORDER BY id DESC LIMIT 1`;
  assert.deepEqual([fetchRun!.status, fetchRun!.new_count], ["ok", run.imported]);

  // The same day again: every answer is reused, nothing is paid for.
  const again = await runActiveSearch();
  assert.deepEqual([again.searched, again.reused, again.imported], [0, 20, 0]);
  assert.equal(requests.length, 20);
});

test("the Beijing day's quota counts every attempt, a failed one included", async () => {
  await reset();
  await seed("basic", 15);
  const run = await runActiveSearch();
  assert.deepEqual([count(depths(), "basic"), count(depths(), "advanced")], [1, 4]);
  assert.equal(run.limited, 15);
  assert.deepEqual(run.usage, { basic: 16, advanced: 4, monthCredits: 15 + 1 + 8 });
});

test("the Beijing month stops at 900 credits; earlier months do not count", async () => {
  await reset();
  await seed("basic", 1, { credits: 897 });
  await seed("advanced", 1, { credits: 5000, daysAgo: 40 });
  const run = await runActiveSearch();
  assert.deepEqual(depths(), ["advanced", "basic"], "2 + 1 credits fit, nothing after");
  assert.equal(run.limited, 18);
  assert.equal((run.usage as { monthCredits: number }).monthCredits, 900);
});

test("a refused request is tried once more, and failures use up the quota", async () => {
  await reset();
  mode = "unavailable";
  const run = await runActiveSearch();
  assert.equal(requests.length, 20, "16 basic and 4 advanced attempts, all failed");
  assert.deepEqual([count(depths(), "basic"), count(depths(), "advanced")], [16, 4]);
  assert.deepEqual([run.searched, run.failed, run.limited], [0, 10, 10], "each search sent twice until the quota ran out");
  const [source] = await sql<{ health: string; last_error: string | null }[]>`SELECT health, last_error FROM sources WHERE id = ${SOURCE}`;
  assert.notEqual(source!.health, "ok");
  assert.match(source!.last_error ?? "", /503/);

  mode = "ok";
  const later = await runActiveSearch();
  assert.equal(requests.length, 20, "the failed attempts spent the day's quota");
  assert.equal(later.limited, 20);
});

test("a refusal of the account stops the run", async () => {
  await reset();
  mode = "unauthorized";
  const run = await runActiveSearch();
  assert.equal(requests.length, 1);
  assert.deepEqual([run.failed, run.stopped], [1, "HTTP 401"]);
});

test("an answer received but not stored is stored by the next run without paying again", async () => {
  await reset();
  await sql.unsafe(`CREATE FUNCTION fail_search_storage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.source_id = '${SOURCE}' THEN RAISE EXCEPTION 'injected search storage failure'; END IF;
    RETURN NEW; END $$`);
  await sql`CREATE TRIGGER fail_search_storage BEFORE INSERT ON articles FOR EACH ROW EXECUTE FUNCTION fail_search_storage()`;
  let first: Record<string, unknown> = {};
  try {
    first = await runActiveSearch();
  } finally {
    await sql`DROP TRIGGER fail_search_storage ON articles`;
    await sql`DROP FUNCTION fail_search_storage()`;
  }
  assert.deepEqual([first.searched, first.failed, first.imported], [20, 20, 0]);
  const received = await sql`SELECT 1 FROM receipts WHERE service = 'tavily' AND status = 'received'`;
  assert.equal(received.length, 20);

  const next = await runActiveSearch();
  assert.equal(requests.length, 20, "nothing is bought again");
  assert.equal(next.recovered, 20);
  assert.ok(Number(next.imported) > 0);
  const [lead] = await sql<{ raw: { search: { query: string } } }[]>`SELECT raw FROM articles WHERE url = ${fresh(String(requests[3]!.body.query))}`;
  assert.equal(lead!.raw.search.query, requests[3]!.body.query, "the stored request says which query found it");
  const open = await sql`SELECT 1 FROM receipts WHERE service = 'tavily' AND status <> 'completed'`;
  assert.equal(open.length, 0);
});

test("the model writes half the queries once a day; a re-run reads them back instead of asking again", async () => {
  await reset();
  config.modelCallsEnabled = true;
  process.env.SEARCH_MODEL = "deepseek-flash";
  modelQueries = [
    { lane: "reddit", query: `reddit r/SaaS annual plan discount churn ${T}` },
    { lane: "reddit", query: `site:reddit.com pricing ${T}` },
    { lane: "niche-need", query: `veterinary clinics appointment reminder software complaints ${T}` },
  ];
  try {
    const run = await runActiveSearch();
    assert.equal(run.model, "generated");
    assert.equal(llmHits, 1);
    const sent = requests.map((r) => String(r.body.query));
    assert.equal(sent.length, 20);
    assert.ok(sent.includes(modelQueries[0]!.query));
    assert.ok(sent.includes(modelQueries[2]!.query));
    assert.ok(!sent.includes(modelQueries[1]!.query), "search syntax is not used");
    assert.equal(sent.filter((q) => !TEMPLATES.has(q)).length, 2, "templates fill the rest");

    const again = await runActiveSearch();
    assert.equal(again.model, "cached");
    assert.equal(llmHits, 1, "the morning's queries are reused, not asked again");
    assert.equal(requests.length, 20);
  } finally {
    config.modelCallsEnabled = false;
    delete process.env.SEARCH_MODEL;
  }
});
