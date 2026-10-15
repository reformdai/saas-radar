import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalRead, localBatch, deliverLocalBatch, deliverLocalDiscovery, type LocalState } from "../packages/backend/src/wechat/local.ts";
import type { WechatIntake } from "@aihot/contracts/wechat";

const initial = (): LocalState => ({ version: 1, identity: "synthetic-root:1", account: "synthetic", destination: "http://localhost", groups: ["1@chatroom", "2@chatroom"], since: 1, seen: {}, ids: {} });
const row = (group = "1@chatroom", id = "9007199254740993", local = "message_1.db/1", time = 100) => ({ local: `${group}/${local}`, target: "", event: {
  group_id: group, group_name: "同名群", message_id: id, sender_id: "same-member", sender_name: "群友", content: "讨论内容", sent_at: time, revoked: false,
} });
const input = (rows: ReturnType<typeof row>[]) => ({ identity: "synthetic-root:1", groups: [{ id: "1@chatroom", name: "同名群" }, { id: "2@chatroom", name: "同名群" }], rows, pending: 0 });

test("local discovery accepts large catalogs and delivers bounded batches without losing groups", async () => {
  const groups = Array.from({ length: 371 }, (_, i) => ({ id: `${i + 1}@chatroom`, name: "合成群" }));
  const parsed = LocalRead.parse({ ...input([]), groups });
  const sent: Array<{ account: string; groups: typeof groups }> = [];
  await deliverLocalDiscovery("synthetic", parsed.groups, async body => { sent.push(body); });
  assert.deepEqual(sent.map(b => b.groups.length), [100, 100, 100, 71]);
  assert.deepEqual(sent.flatMap(b => b.groups), groups);
  assert.ok(sent.every(b => b.account === "synthetic"));
  let calls = 0;
  await assert.rejects(deliverLocalDiscovery("synthetic", groups, async () => {
    if (++calls === 2) throw new Error("synthetic outage");
  }), /outage/);
  assert.equal(calls, 2);
});

test("local intake preserves big IDs, group/shard identity, late messages and restart deduplication", () => {
  const first = localBatch(input([row(), row("2@chatroom"), row("1@chatroom", "9007199254740994", "message_2.db/1")]), initial());
  assert.equal(first.events.length, 3);
  assert.equal(first.events[0]!.message_id, "9007199254740993");
  const late = row("1@chatroom", "12", "message_2.db/2", 2);
  const state = JSON.parse(JSON.stringify(first.next)) as LocalState;
  const second = localBatch(input([row(), row("2@chatroom"), row("1@chatroom", "9007199254740994", "message_2.db/1"), late]), state);
  assert.deepEqual(second.events, [late.event]);
  assert.equal(localBatch(input([late]), second.next).events.length, 0);
});

test("local intake tracks edits and resolves in-place revocation without using system message ID", () => {
  const first = localBatch(input([row()]), initial());
  const edited = row(); edited.event.content = "补充后的正文";
  const second = localBatch(input([edited]), first.next);
  assert.equal(second.events[0]!.content, "补充后的正文");
  const revoked = row(); revoked.event.revoked = true; revoked.event.message_id = "0";
  const third = localBatch(input([revoked]), second.next);
  assert.equal(third.events[0]!.message_id, "9007199254740993");
  assert.equal(third.events[0]!.content, "");
  const unknown = localBatch(input([revoked, row("2@chatroom")]), initial());
  assert.equal(unknown.pending, 1);
  assert.deepEqual(unknown.unresolvedGroups, ["1@chatroom"]);
  assert.deepEqual(unknown.events, [row("2@chatroom").event]);
  revoked.target = "123";
  assert.equal(localBatch(input([revoked]), initial()).events[0]!.message_id, "123");
});

test("pending sends are revisited, ambiguous identities fail without mutating saved state", () => {
  const pending = row(); pending.event.message_id = "0";
  const state = initial();
  assert.equal(localBatch(input([pending]), state).events.length, 0);
  assert.equal(localBatch(input([row()]), state).events.length, 1);
  assert.deepEqual(state, initial());
  assert.throws(() => localBatch({ ...input([]), identity: "different-account" }, state), /账号/);
  const bad = row(); bad.event.group_id = "2@chatroom";
  assert.throws(() => localBatch(input([bad]), state), /身份/);
  const conflict = row("1@chatroom", "9007199254740993", "message_2.db/1"); conflict.event.content = "冲突";
  assert.throws(() => localBatch(input([row(), conflict]), state), /分片/);
});

test("local delivery batches messages and never advances checkpoint after a failed batch", async () => {
  const events = Array.from({ length: 101 }, (_, i) => row("1@chatroom", String(i + 1)).event);
  const sent: WechatIntake[] = [];
  await deliverLocalBatch("synthetic", input([]).groups, 1, events, 200, async b => { sent.push(b); });
  assert.deepEqual(sent.filter(b => b.events).map(b => b.events!.length), [50, 50, 1]);
  assert.equal(sent.at(-1)!.checkpoints![0]!.through, 200);
  const failed: WechatIntake[] = [];
  await assert.rejects(deliverLocalBatch("synthetic", input([]).groups, 1, events, 200, async b => {
    if (failed.length === 2) throw new Error("synthetic outage");
    failed.push(b);
  }), /outage/);
  assert.ok(failed.every(b => !b.checkpoints));
  const partial: WechatIntake[] = [];
  await deliverLocalBatch("synthetic", input([]).groups, 1, events, 200, async b => { partial.push(b); }, ["1@chatroom"]);
  assert.deepEqual(partial.at(-1)!.checkpoints, [{ groupId: "2@chatroom", through: 200 }]);
});
