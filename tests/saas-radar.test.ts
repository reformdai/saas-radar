// The SaaS radar's industry pack and its 今日发现 labels, without a database: the demo sources map
// local samples shaped like the Hacker News search API and a Reddit search feed (no outside requests),
// what was fetched of the original is labelled without claiming the content was verified, and the
// taxonomy, topics and the understanding prompt name the same tags.
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { fetchRss } from "@aihot/backend/sources/rss";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { arrivalOf, materialStatus } from "@aihot/backend/publication/discoveries";
import { ARRIVAL_LABELS, MATERIAL_LABELS } from "@aihot/contracts/site";
import { CATEGORY_TAGS, ENTITIES, ENTITY_TAGS, TOPIC_TAGS } from "@aihot/industry/taxonomy";
import { escapeXml } from "@aihot/backend/lib/text";

const root = new URL("../", import.meta.url);
const { sources } = JSON.parse(readFileSync(new URL("industry/sources.json", root), "utf8")) as {
  sources: Array<{ id: string; kind: "rss" | "json_list"; config: Record<string, any>; participation_mode: string }>;
};

const HN = {
  hits: [
    { objectID: "41000001", title: "Show HN: An invoicing tool for freelancers", url: "https://example.org/invoices", author: "maker", created_at: "2026-10-01T08:00:00Z", created_at_i: 1790841600, story_text: null },
    { objectID: "41000002", title: "Ask HN: How did you find your first customers?", url: null, author: "asker", created_at: "2026-10-02T09:30:00Z", created_at_i: 1790933400, story_text: "<p>I launched a <i>B2B</i> tool last month.</p>" },
    { objectID: "41000003", title: "Ask HN: Pricing a SaaS for agencies", author: "pricer", created_at_i: 1790937000 },
  ],
};
const longPost = `I run a small SaaS for dentists. ${"We tried cold email, SEO and partnerships before anything worked. ".repeat(8)}`;
const shortPost = "Our dental clinic exports insurance claim reports by hand every week. Is there a tool for this? Budget is $50 a month.";
const reddit = (content: string, id: string, summary = "") =>
  `<entry><id>t3_${id}</id><title>How I got my first ${id} customers</title><updated>2026-10-02T10:00:00+00:00</updated>` +
  `<link href="https://www.reddit.com/r/SaaS/comments/${id}/post/"/>` +
  (summary ? `<summary>${escapeXml(summary)}</summary>` : "") +
  `<content type="html">${escapeXml(content)}</content></entry>`;
const REDDIT = `<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:test</id><title>search</title><updated>2026-10-02T10:00:00+00:00</updated>` +
  reddit(`<div class="md"><p>${longPost}</p></div> submitted by /u/founder [link] [comments]`, "long") +
  reddit(`<div class="md"><p>${shortPost}</p></div> submitted by /u/someone [link] [comments]`, "short") +
  reddit(`<div class="md"><p>Anyone else stuck at zero?</p></div>`, "summarized", "The feed's own summary.") +
  `</feed>`;

const server = http.createServer((req, res) => {
  if (req.url!.startsWith("/hn")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(HN));
  } else {
    res.setHeader("content-type", "application/atom+xml");
    res.end(REDDIT);
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const previousPrivateFetch = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivateFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("every demo source has a config its kind supports", () => {
  for (const s of sources) assert.doesNotThrow(() => assertSupportedConfig(s.kind, s.config), s.id);
});

test("the Hacker News search sources keep the original link, fall back to the discussion and read the epoch time", async () => {
  const hn = sources.filter((s) => s.kind === "json_list");
  assert.ok(hn.length >= 2);
  for (const s of hn) {
    const items = await fetchJsonList({ id: s.id, kind: s.kind, participation_mode: s.participation_mode, config: { ...s.config, url: `${base}/hn` } } as never);
    assert.deepEqual(items.map((i) => i.url), [
      "https://example.org/invoices",
      "https://news.ycombinator.com/item?id=41000002",
      "https://news.ycombinator.com/item?id=41000003",
    ], "a story without url links to its discussion");
    assert.equal(items[0]!.publishedAt!.toISOString(), "2026-10-01T08:00:00.000Z");
    assert.equal(items[1]!.publishedAt!.toISOString(), "2026-10-02T09:30:00.000Z");
    assert.equal(items[1]!.excerpt, "I launched a B2B tool last month.");
    assert.equal(items[1]!.author, "asker");
    assert.deepEqual(items.map((i) => i.bodyStatus), ["pending", "pending", "pending"], "a search hit is a lead, not the article body");
  }
});

test("a Reddit search feed keeps a full self post as its body and a short one as a summary", async () => {
  const feed = sources.find((s) => s.config.feedUrl?.startsWith("https://www.reddit.com/"))!;
  const { candidates } = await fetchRss({ ...feed, config: { ...feed.config, feedUrl: `${base}/reddit` } } as never);
  const long = candidates.find((c) => c.url.includes("/long/"))!;
  const short = candidates.find((c) => c.url.includes("/short/"))!;
  const summarized = candidates.find((c) => c.url.includes("/summarized/"))!;
  assert.equal(long.bodyStatus, "ok");
  assert.ok(long.bodyText!.includes("cold email"));
  assert.equal(long.excerpt, null, "a full body needs no excerpt");
  assert.equal(short.bodyStatus, "pending");
  assert.equal(short.bodyText, null);
  assert.ok(short.excerpt!.startsWith(shortPost), "the short post's words are kept as the summary");
  assert.equal(materialStatus({ body_status: short.bodyStatus, has_body: !!short.bodyText, has_excerpt: !!short.excerpt }), "excerpt");
  assert.equal(summarized.excerpt, "The feed's own summary.", "the entry's own summary comes first");
  assert.equal(summarized.bodyStatus, "pending");
  assert.equal(long.publishedAt!.toISOString(), "2026-10-02T10:00:00.000Z");
});

test("material status says what was fetched, never that it was verified", () => {
  assert.equal(materialStatus({ body_status: "ok", has_body: true, has_excerpt: true }), "body");
  assert.equal(materialStatus({ body_status: "ok", has_body: false, has_excerpt: true }), "excerpt", "ok without a stored body is not a body");
  for (const status of ["pending", "unconfirmed", "none"]) {
    assert.equal(materialStatus({ body_status: status, has_body: false, has_excerpt: true }), "excerpt");
    assert.equal(materialStatus({ body_status: status, has_body: false, has_excerpt: false }), "title");
  }
  assert.deepEqual(Object.values(MATERIAL_LABELS).map((l) => l.label), ["正文已获取", "仅摘要", "仅标题"]);
  for (const l of Object.values(MATERIAL_LABELS)) assert.doesNotMatch(l.label, /核实|验证|可信/);
  assert.match(MATERIAL_LABELS.body.hint, /不代表内容经过核实/);
});

test("arrival separates live material from first imports, late finds and backfill", () => {
  assert.equal(arrivalOf({ backfill: false, backfill_reason: null }), "live");
  assert.equal(arrivalOf({ backfill: true, backfill_reason: "first-import" }), "first-import");
  assert.equal(arrivalOf({ backfill: true, backfill_reason: "stale-on-discovery" }), "late");
  assert.equal(arrivalOf({ backfill: true, backfill_reason: "reported-backfill" }), "backfill");
  assert.deepEqual(Object.keys(ARRIVAL_LABELS).sort(), ["backfill", "first-import", "late"]);
});

test("topics, entities and the understanding prompt use the taxonomy's tags", () => {
  const { topics } = JSON.parse(readFileSync(new URL("industry/topics.json", root), "utf8")) as { topics: Array<{ slug: string; entityId?: string; tags: string[]; related?: string[] }> };
  const allowed = new Set<string>([...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS]);
  const slugs = new Set(topics.map((t) => t.slug));
  for (const t of topics) {
    for (const tag of t.tags) assert.ok(allowed.has(tag) || (tag.startsWith("entity:") && tag.slice(7) in ENTITIES), `${t.slug}: ${tag}`);
    if (t.entityId) assert.ok(t.entityId in ENTITIES, t.slug);
    for (const r of t.related ?? []) assert.ok(slugs.has(r), `${t.slug} → ${r}`);
  }
  const prompt = readFileSync(new URL("industry/prompts/content-understanding.md", root), "utf8");
  for (const tag of allowed) assert.ok(prompt.includes(tag), `content-understanding.md lists ${tag}`);
  assert.match(prompt, /researchQuestion/);
});
