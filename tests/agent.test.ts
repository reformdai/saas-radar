import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { agentConversation, cancelAgentProposal, runAgentTurn, sendAgentMessage } from "@aihot/backend/agent/index";
import { confirmAgentProposal } from "@aihot/backend/admin/agent";

const owner = `agent-${tag()}`;
const RSS = `agent-rss-${tag()}`;
const MP = `agent-mp-${tag()}`;
// Each model request takes the next scripted step; the requests are kept to check what the model saw.
let script: unknown[] = [];
const seen: Array<{ system: string; user: { conversation: Array<{ role: string; text: string }>; this_turn: Array<Record<string, unknown>> }; raw: string }> = [];
const llm = await stub((_hit, req) => {
  const body = JSON.parse(req.body);
  seen.push({ system: body.messages[0].content, user: JSON.parse(body.messages[1].content), raw: req.body });
  const step = script.shift() ?? { say: "（剧本用完）", action: null };
  return { id: `chat-${seen.length}`, choices: [{ message: { content: JSON.stringify(step) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } };
});
const saved = { modelCalls: config.modelCallsEnabled };
let savedBudget: { per_minute: number; per_hour: number; per_day: number } | undefined;

before(async () => {
  Object.assign(process.env, { LLM_BASE_URL: llm.url, LLM_API_KEY: "test-llm-key", LLM_MODEL: "test-agent-model" });
  config.modelCallsEnabled = true;
  [savedBudget] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'llm'`;
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 1000, per_day = 100000 WHERE service = 'llm'`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at)
    VALUES (${RSS}, '测试博客', 'rss', 'T2', 'editorial', ${sql.json({ url: `https://example.com/${RSS}.xml`, apiToken: "do-not-send-me" })}, '2100-01-01')`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, config, next_fetch_at)
    VALUES (${MP}, '测试公众号', 'mp_account', 'T2', 'editorial', ${sql.json({ ghid: `gh-${MP}`, listProvider: "everyinfra" })}, '2100-01-01')`;
});

after(async () => {
  if (savedBudget) await sql`UPDATE budgets SET per_minute = ${savedBudget.per_minute}, per_hour = ${savedBudget.per_hour}, per_day = ${savedBudget.per_day} WHERE service = 'llm'`;
  config.modelCallsEnabled = saved.modelCalls;
  await llm.close();
  await stopBoss();
  await closeDb();
});

async function ask(message: string, conversationId: string | null = null) {
  const c = await sendAgentMessage({ message, conversationId }, owner, randomUUID());
  assert.equal(c.status, "thinking");
  await runAgentTurn(c.id);
  return (await agentConversation(c.id, owner))!;
}

test("a question runs read tools on its own and ends with an answer, without credentials reaching the model", async () => {
  script = [{ say: "", action: { tool: "source_detail", args: { id: RSS } } }, { say: "测试博客好着呢，就是没啥新东西。", action: null }];
  seen.length = 0;
  const c = await ask("测试博客最近怎么样");
  assert.equal(c.status, "idle", c.error ?? "");
  assert.deepEqual(c.messages.map((m) => m.role), ["user", "tool", "agent"]);
  assert.match(c.messages[1]!.role === "tool" ? c.messages[1]!.summary : "", /测试博客/);
  assert.equal(seen.length, 2);
  const fed = seen[1]!.user.this_turn[0]!;
  assert.equal((fed.result as { source: { id: string } }).source.id, RSS, "the read result goes back to the model");
  assert.ok(!seen.some((s) => s.raw.includes("do-not-send-me")), "credential-like config stays out of the model request");
  assert.match(seen[0]!.system, /小雷/);
});

test("a change waits on a confirmation card, then runs through the admin function and is audited", async () => {
  script = [{ say: "万有引擎摆烂了，换极致了吧，确认卡给你。", action: { tool: "update_source", args: { id: MP, patch: { config: { listProvider: "dajiala" } } } } }];
  const c = await ask("把测试公众号换成极致了");
  assert.equal(c.status, "awaiting", c.error ?? "");
  assert.equal(c.pending?.tool, "update_source");
  assert.ok(c.pending!.lines.includes('config.listProvider："everyinfra" → "dajiala"'), c.pending!.lines.join("\n"));
  const [untouched] = await sql`SELECT config FROM sources WHERE id = ${MP}`;
  assert.equal(untouched!.config.listProvider, "everyinfra", "nothing changes before the confirmation");

  script = [{ say: "搞定，以后走极致了。", action: null }];
  const confirmed = await confirmAgentProposal(c.id, c.pending!.id, owner);
  assert.equal(confirmed.status, "thinking");
  const [changed] = await sql`SELECT config FROM sources WHERE id = ${MP}`;
  assert.deepEqual(changed!.config, { ghid: `gh-${MP}`, listProvider: "dajiala" }, "the config is merged, not replaced");
  const [audited] = await sql`SELECT actor FROM audit_log WHERE subject = ${`source:${MP}`} AND action = 'source.update' ORDER BY id DESC LIMIT 1`;
  assert.equal(audited!.actor, owner);
  await assert.rejects(confirmAgentProposal(c.id, c.pending!.id, owner), /已经处理过/, "the same card runs once");

  await runAgentTurn(c.id);
  const done = (await agentConversation(c.id, owner))!;
  assert.equal(done.status, "idle");
  const action = done.messages.find((m) => m.role === "action");
  assert.equal(action?.role === "action" && action.outcome, "done");
  const reply = done.messages.at(-1)!;
  assert.equal(reply.role === "agent" && reply.text, "搞定，以后走极致了。");
  assert.ok(seen.at(-1)!.user.conversation.some((m) => m.role === "系统" && m.text.includes("已执行")), "the agent hears what came of it");
});

test("a cancelled card changes nothing, and a card gone stale fails instead of overwriting", async () => {
  script = [{ say: "停掉？行。", action: { tool: "update_source", args: { id: RSS, patch: { enabled: false } } } }];
  const c = await ask("先停了测试博客");
  assert.equal(c.status, "awaiting", c.error ?? "");
  const cancelled = await cancelAgentProposal(c.id, c.pending!.id, owner);
  assert.equal(cancelled.status, "idle");
  const [still] = await sql`SELECT enabled FROM sources WHERE id = ${RSS}`;
  assert.equal(still!.enabled, true);

  script = [{ say: "那就停。", action: { tool: "update_source", args: { id: RSS, patch: { enabled: false } } } }, { say: "有人先改过了，你刷新再说。", action: null }];
  const again = await ask("还是停了吧", c.id);
  assert.equal(again.status, "awaiting");
  await sql`UPDATE sources SET updated_at = now() + interval '1 second' WHERE id = ${RSS}`;
  await confirmAgentProposal(c.id, again.pending!.id, owner);
  const [unchanged] = await sql`SELECT enabled FROM sources WHERE id = ${RSS}`;
  assert.equal(unchanged!.enabled, true, "a stale version is not overwritten");
  const last = (await agentConversation(c.id, owner))!.messages.filter((m) => m.role === "action").at(-1)!;
  assert.equal(last.role === "action" && last.outcome, "failed");
  assert.match(last.role === "action" ? last.detail : "", /已被其他操作修改/);
});

test("an unknown tool or bad arguments go back to the model instead of stopping the conversation", async () => {
  script = [
    { say: "", action: { tool: "drop_everything", args: {} } },
    { say: "", action: { tool: "archive", args: { sourceId: MP, action: "explode" } } },
    { say: "这个我干不了。", action: null },
  ];
  seen.length = 0;
  const c = await ask("把库清了");
  assert.equal(c.status, "idle", c.error ?? "");
  const failures = c.messages.filter((m) => m.role === "tool" && !m.ok);
  assert.equal(failures.length, 2);
  assert.equal(seen[2]!.user.this_turn.filter((t) => t.error).length, 2);
  assert.equal(c.pending, null);
});
