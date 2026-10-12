import { tag, gate, stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { receiveWechat, pauseWechat } from "../packages/backend/src/wechat/store.ts";
import { buildWechatDigest, invalidateWechatDigest, wechatDigestDetail, wechatDigestFeed } from "../packages/backend/src/wechat/digests.ts";
import { localBatch, deliverLocalBatch, LocalRead, type LocalState } from "../packages/backend/src/wechat/local.ts";
import { buildApp } from "../apps/api/src/app.ts";
import type { WechatEvent } from "@aihot/contracts/wechat";

after(closeDb);
const group = "54321@chatroom";
const when = Date.parse("2026-10-01T10:00:00+08:00") / 1000;
const event = (id: string, content = "合成群聊讨论"): WechatEvent => ({ group_id: group, group_name: "合成群", message_id: id, sender_id: "member", sender_name: "群友", content, sent_at: when, revoked: false });
const answer = async (_input: unknown, ids: Set<string>) => [{ title: "合成要点", summary: "合成证据支持的结论", evidenceIds: [...ids] }];

test("intake invalidates only changed days; summaries retain valid evidence and reject stale model output", async () => {
  const account = `digest_${tag()}`;
  const key = { account, group, day: "2026-10-01" };
  await receiveWechat({ account, groups: [{ id: group, name: "合成群" }], initialSince: 1, events: [event("9007199254740993")] });
  const revision = async () => (await sql<{ revision: number }[]>`SELECT revision FROM wechat_digests WHERE account = ${account} AND group_id = ${group} AND day = ${key.day}`)[0]!.revision;
  const first = await revision();
  await receiveWechat({ account, events: [event("9007199254740993")] });
  assert.equal(await revision(), first);
  assert.deepEqual(await buildWechatDigest(key, answer), { published: true, superseded: false });
  const ready = await wechatDigestDetail(key);
  assert.equal(ready!.digest.points[0]!.evidenceIds[0], "9007199254740993");
  assert.equal(ready!.messages[0]!.content, "合成群聊讨论");
  await receiveWechat({ account, events: [event("2", "新增讨论")] });
  const started = gate(), finish = gate();
  const building = buildWechatDigest(key, async (input, ids) => { started.open(); await finish.promise; return answer(input, ids); });
  await started.promise;
  try {
    await receiveWechat({ account, events: [{ ...event("9007199254740993"), revoked: true }] });
    const invalidated = await wechatDigestDetail(key);
    assert.equal(invalidated!.digest.status, "pending");
    assert.deepEqual(invalidated!.digest.points, []);
    assert.deepEqual(invalidated!.messages, []);
  } finally { finish.open(); }
  assert.deepEqual(await building, { published: false, superseded: true });
  await buildWechatDigest(key, answer);
  const refreshed = await wechatDigestDetail(key);
  assert.deepEqual(refreshed!.digest.points[0]!.evidenceIds, ["2"]);
  assert.equal(refreshed!.messages.length, 1);
});

test("bad model evidence stays unpublished; paused groups disappear and model valve stays closed", async () => {
  const account = `digest_${tag()}`;
  const key = { account, group, day: "2026-10-01" };
  await receiveWechat({ account, groups: [{ id: group, name: "合成群" }], initialSince: 1, events: [event("1")] });
  const failed = await buildWechatDigest(key, async () => [{ title: "捏造", summary: "无依据", evidenceIds: ["missing"] }]);
  assert.deepEqual(failed, { failed: true });
  assert.equal((await wechatDigestDetail(key))!.digest.status, "error");
  assert.deepEqual((await wechatDigestDetail(key))!.digest.points, []);
  assert.deepEqual(await buildWechatDigest(key), { skipped: true });
  await buildWechatDigest(key, answer);
  await pauseWechat({ account, groupId: group, enabled: false }, "synthetic-test");
  assert.equal(await wechatDigestDetail(key), null);
  assert.ok((await wechatDigestFeed({})).items.every(d => d.account !== account));
});

test("encrypted local fixture passes intake, model receipts and private summary API independently of reference projects", async () => {
  const { stdout } = await promisify(execFile)("python3", ["-B", "-c", `
import json
from test_reader import ReaderTests
case = ReaderTests()
case.setUp()
try:
    reader = case.fixture()
    print(json.dumps(reader.read(['1@chatroom'], 1)))
finally:
    case.doCleanups()
`], { env: { ...process.env, PYTHONPATH: fileURLToPath(new URL("../scripts/wechat", import.meta.url)) }, timeout: 10000 });
  const raw = LocalRead.parse(JSON.parse(stdout));
  const account = `pipeline_${tag()}`;
  const state: LocalState = { version: 1, identity: raw.identity, account, destination: "synthetic-api", groups: ["1@chatroom"], since: 1, seen: {}, ids: {} };
  const batch = localBatch(raw, state);
  const saved = { enabled: config.modelCallsEnabled, admin: config.devAdmin,
    env: Object.fromEntries(["INGEST_TOKEN", "WECHAT_SUMMARIES_ENABLED", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"].map(k => [k, process.env[k]])) };
  const provider = await stub((_hit, request) => {
    const input = JSON.parse(request.body);
    const material = JSON.parse(input.messages.at(-1).content);
    assert.ok(material.messages.every((m: { speaker: string }) => m.speaker === "发言者1"));
    assert.doesNotMatch(request.body, /群友|member/);
    return { choices: [{ message: { content: JSON.stringify({ points: [{ title: "加密夹具讨论", summary: "从本机合成群中提炼的要点", evidenceIds: material.messages.map((m: { id: string }) => m.id) }] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  });
  Object.assign(process.env, { INGEST_TOKEN: "synthetic-intake-token-20261007", WECHAT_SUMMARIES_ENABLED: "true", LLM_BASE_URL: provider.url, LLM_API_KEY: "synthetic-model-key", LLM_MODEL: `synthetic-model-${account}` });
  config.modelCallsEnabled = true; // Only this localhost stub is configured; no real model credentials.
  const app = await buildApp();
  try {
    await deliverLocalBatch(account, raw.groups, 1, batch.events, Math.floor(Date.now() / 1000), async body => {
      const reply = await app.inject({ method: "POST", url: "/api/ingest/wechat", headers: { authorization: `Bearer ${process.env.INGEST_TOKEN}` }, payload: body });
      assert.equal(reply.statusCode, 200);
      if (body.events) assert.equal(reply.json().accepted, body.events.length);
    });
    const key = { account, group: "1@chatroom", day: "1970-01-01" };
    assert.deepEqual(await buildWechatDigest(key), { published: true, superseded: false });
    assert.equal(provider.hits(), 1);
    const receipts = await sql<{ status: string }[]>`SELECT status FROM receipts WHERE purpose = 'wechat_digest' AND subject = ${`wechat:${account}/1@chatroom/1970-01-01`}`;
    assert.deepEqual(receipts.map(r => r.status), ["completed"]);
    await sql.begin(tx => invalidateWechatDigest(tx, account, key.group, key.day));
    assert.deepEqual(await buildWechatDigest(key), { published: true, superseded: false });
    assert.equal(provider.hits(), 1, "same input reuses its paid receipt");
    config.devAdmin = { displayName: "Synthetic pipeline admin" };
    const detail = await app.inject({ method: "GET", url: `/api/admin/wechat/digest?${new URLSearchParams(key)}` });
    assert.equal(detail.statusCode, 200);
    assert.match(String(detail.headers["cache-control"]), /no-store/);
    const data = detail.json();
    assert.equal(data.digest.points[0].title, "加密夹具讨论");
    assert.equal(data.messages.length, 2);
    assert.equal(data.messages[0].message_id, "9007199254740993");
    assert.equal(localBatch(raw, batch.next).events.length, 0);
  } finally {
    config.modelCallsEnabled = saved.enabled; config.devAdmin = saved.admin;
    for (const [key, value] of Object.entries(saved.env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await app.close(); await provider.close();
  }
});
