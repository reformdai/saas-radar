import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { searchKnowledge } from "@aihot/backend/knowledge/search";
import { agentConversation, runAgentTurn, sendAgentMessage } from "@aihot/backend/agent/index";

const T = tag();
// Unique words, so rows other test files leave in the shared database never match.
const TOPIC = `zq${T}`;
const OTHER = `zx${T}`;
const BLOG = `kb-blog-${T}`;
const MP = `kb-mp-${T}`;
const ACCOUNT = `kb-${T}`;
const GROUP = `${T}@chatroom`;
const owner = `kb-${T}`;
const filler = (n: number) => "这是一段与问题无关的铺垫文字，用来把正文撑长。".repeat(n);

let script: unknown[] = [];
const seen: Array<{ stream: boolean; system: string; user: string }> = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({ stream: !!body.stream, system: body.messages[0].content, user: body.messages[1].content });
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const piece of ["结论：作者认为先做", "小而美的工具[1]，", "群友也提到要先找付费用户[2]。"]) {
        res.write(`data: ${JSON.stringify({ id: "kb-answer", choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.end(`data: ${JSON.stringify({ id: "kb-answer", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const step = script.shift() ?? { say: "（剧本用完）", action: null };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: `kb-${seen.length}`, choices: [{ message: { content: JSON.stringify(step) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
});
const saved = { modelCalls: config.modelCallsEnabled };
let savedBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;

async function article(id: string, source: string, title: string, body: string, published: string, visibility?: "withdrawn") {
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, published_at, discovered_at, timeline_at, body_status, body_text, excerpt)
    VALUES (${id}, ${source}, ${id}, ${`https://example.test/${id}`}, ${title}, ${published}, ${published}, ${published}, 'ok', ${body}, ${title})`;
  if (visibility) await sql`INSERT INTO editorial_overrides (article_id, visibility, reason) VALUES (${id}, ${visibility}, 'test')`;
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  Object.assign(process.env, { LLM_BASE_URL: `http://127.0.0.1:${port}`, LLM_API_KEY: "test-llm-key", LLM_MODEL: "test-agent-model" });
  config.modelCallsEnabled = true;
  [savedBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'llm'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 1000, per_day = 100000 WHERE service = 'llm'`;
  // A blog without public full text: its body is still the administrator's material.
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at, site_fulltext)
    VALUES (${BLOG}, ${`测试博客${T}`}, 'rss', 'T2', 'editorial', ${sql.json({ url: `https://example.com/${BLOG}.xml` })}, '2100-01-01', false)`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at, site_fulltext)
    VALUES (${MP}, ${`小排公众号${T}`}, 'mp_account', 'T2', 'editorial', ${sql.json({ ghid: `gh-${MP}` })}, '2100-01-01', true)`;
  // The evidence sits 12,000 characters in; a newer article mentions the word once in passing.
  await article(`${MP}-deep`, MP, "一篇很长的复盘", `${filler(500)}关于${TOPIC}，我的做法是先做小而美的工具，再用${TOPIC}${OTHER}验证付费意愿。${filler(40)}`, "2025-01-01T00:00:00Z");
  await article(`${BLOG}-new`, BLOG, "最新随笔", `${filler(20)}顺便提一句${TOPIC}。${filler(20)}`, "2026-10-01T00:00:00Z");
  await article(`${BLOG}-gone`, BLOG, `已撤回的${TOPIC}${OTHER}`, `${TOPIC}${OTHER}${TOPIC}${OTHER}`, "2026-10-02T00:00:00Z", "withdrawn");

  await sql`INSERT INTO wechat_groups (account, group_id, name, reconcile_through) VALUES (${ACCOUNT}, ${GROUP}, ${`出海群${T}`}, 1)`;
  const at = Date.parse("2026-10-10T02:00:00Z") / 1000;
  for (let i = 0; i < 30; i++) {
    const text = i === 15 ? `${TOPIC}要先找付费用户，联系我 13812345678` : `闲聊第 ${i} 条`;
    await sql`INSERT INTO wechat_messages (account, group_id, message_id, sender_id, sender_name, content, sent_at)
      VALUES (${ACCOUNT}, ${GROUP}, ${`m${String(i).padStart(2, "0")}`}, ${`wxid-${i % 3}`}, ${`真名${i % 3}`}, ${text}, ${at + i * 60})`;
  }
  await sql`INSERT INTO wechat_digests (account, group_id, day, status, points, message_count)
    VALUES (${ACCOUNT}, ${GROUP}, '2026-10-10', 'ready', ${sql.json([{ title: `${TOPIC}的讨论`, summary: "大家认为先验证付费", evidenceIds: ["m15"] }])}, 30)`;
});

after(async () => {
  if (savedBudget) await sql`UPDATE budgets SET per_minute = ${savedBudget.per_minute}, per_hour = ${savedBudget.per_hour}, per_day = ${savedBudget.per_day} WHERE service = 'llm'`;
  config.modelCallsEnabled = saved.modelCalls;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopBoss();
  await closeDb();
});

test("the passage that matches comes back even deep in a long article, ranked above a passing mention, and withdrawn content never", async () => {
  const hits = await searchKnowledge({ q: `${TOPIC} ${OTHER} 怎么做`, kind: "article" });
  assert.ok(hits.length >= 2, JSON.stringify(hits.map((h) => h.title)));
  assert.equal(hits[0]!.title, "一篇很长的复盘");
  assert.match(hits[0]!.quote, /小而美的工具/);
  assert.equal(hits[0]!.href, `/mp/articles/${MP}-deep`);
  assert.ok(!hits.some((h) => h.title.startsWith("已撤回")), "withdrawn content is not material");
  // The blog has no public full text, yet its body is searched.
  const blog = hits.find((h) => h.title === "最新随笔");
  assert.ok(blog && !blog.quote.startsWith("（只有摘要）"));
  assert.equal(blog.url, `https://example.test/${BLOG}-new`);
});

test("a source name filters, and the article being read is searched alone", async () => {
  const mine = await searchKnowledge({ q: TOPIC, source: `小排公众号${T}`, kind: "article" });
  assert.deepEqual([...new Set(mine.map((h) => h.source))], [`小排公众号${T}`]);
  const one = await searchKnowledge({ q: "总结一下", articleId: `${BLOG}-new` });
  assert.ok(one.length > 0 && one.every((h) => h.title === "最新随笔"));
});

test("group digests and the conversation around a matching message come back anonymised", async () => {
  const hits = await searchKnowledge({ q: TOPIC, kind: "wechat" });
  const digest = hits.find((h) => h.kind === "wechat_digest");
  assert.ok(digest, "digest point found");
  assert.match(digest.href!, /day=2026-10-10/);
  const window = hits.find((h) => h.kind === "wechat_messages");
  assert.ok(window, "message window found");
  const lines = window.quote.split("\n").slice(1);
  assert.equal(lines.length, 21, "ten messages either side of the hit");
  assert.match(window.quote, /发言者\d（命中）：zq/);
  assert.doesNotMatch(window.quote, /真名|wxid|13812345678/);
  assert.match(window.quote, /\[手机号\]/);
});

test("小雷 searches, then writes a streamed answer that cites the materials it marks", async () => {
  script = [{ say: "", action: { tool: "search_knowledge", args: { q: `${TOPIC} ${OTHER}` } } }, { say: "", action: { tool: "answer", args: {} } }];
  seen.length = 0;
  const page = { kind: "article" as const, id: `${MP}-deep`, title: "一篇很长的复盘" };
  const sent = await sendAgentMessage({ message: `${TOPIC} 怎么验证？`, conversationId: null, context: page }, owner, randomUUID());
  assert.deepEqual(sent.messages[0], { role: "user", text: `${TOPIC} 怎么验证？`, at: sent.messages[0]!.at, context: page });
  await runAgentTurn(sent.id);
  const c = (await agentConversation(sent.id, owner))!;
  assert.equal(c.status, "idle", c.error ?? "");
  assert.deepEqual(c.messages.map((m) => m.role), ["user", "tool", "agent"]);
  const answer = c.messages[2]!;
  assert.ok(answer.role === "agent");
  assert.equal(answer.text, "结论：作者认为先做小而美的工具[1]，群友也提到要先找付费用户[2]。");
  assert.equal(answer.streaming, undefined);
  assert.deepEqual(answer.citations!.map((x) => x.n), [1, 2]);
  assert.equal(answer.citations![0]!.title, "一篇很长的复盘");
  // The step model saw the page and the numbered materials; the answer model got the same numbers.
  assert.match(seen[0]!.user, /"page":\{"title":"一篇很长的复盘"/);
  assert.match(seen[1]!.user, /"materials":\[\{"n":1/);
  assert.equal(seen[2]!.stream, true);
  assert.match(seen[2]!.user, /小而美的工具/);
  assert.doesNotMatch(seen.map((s) => s.user).join(""), /真名|13812345678/);
});

test("asking to answer before anything was found goes back to the model", async () => {
  script = [{ say: "", action: { tool: "answer", args: {} } }, { say: "资料库里没找到相关内容。", action: null }];
  seen.length = 0;
  const sent = await sendAgentMessage({ message: "随便问问", conversationId: null }, owner, randomUUID());
  await runAgentTurn(sent.id);
  const c = (await agentConversation(sent.id, owner))!;
  assert.equal(c.status, "idle");
  assert.deepEqual(c.messages.map((m) => m.role), ["user", "agent"]);
  assert.ok(seen.every((s) => !s.stream));
  assert.match(seen[1]!.user, /还没有检索到资料/);
});
