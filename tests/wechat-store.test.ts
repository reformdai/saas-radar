import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { pauseWechat, receiveWechat, wechatInbox, wechatStatus } from "../packages/backend/src/wechat/store.ts";

after(closeDb);

test("private inbox deduplicates SSE/poll overlap, isolates accounts and keeps revocation tombstones", async () => {
  const account = `wechat_${tag()}`;
  const other = `${account}_other`;
  const group = "123@chatroom";
  const sent = Math.floor(Date.now() / 1000) - 120;
  const event = { group_id: group, group_name: "Synthetic group", message_id: "18446744073709551615", sender_id: "synthetic", sender_name: "Synthetic sender", content: "Synthetic message", sent_at: sent, revoked: false };
  await receiveWechat({ account, groups: [{ id: group, name: event.group_name }], initialSince: sent - 60 });
  await receiveWechat({ account, events: [event, event] });
  await receiveWechat({ account, events: [event] });
  let inbox = await wechatInbox({ account, group });
  assert.equal(inbox.ready, true);
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0]!.message_id, event.message_id);
  assert.equal(inbox.messages[0]!.sent_at, sent);
  assert.equal((await wechatStatus(account))[0]!.reconcile_through, sent - 60, "SSE does not advance checkpoint");

  await receiveWechat({ account, checkpoints: [{ groupId: group, through: sent + 30 }] });
  await receiveWechat({ account, checkpoints: [{ groupId: group, through: sent }] });
  assert.equal((await wechatStatus(account))[0]!.reconcile_through, sent + 30);
  await receiveWechat({ account, events: [{ ...event, revoked: true, sender_name: "" }] });
  await receiveWechat({ account, events: [event] });
  // Revocation arriving before the original also cannot regain its body.
  await receiveWechat({ account, events: [{ ...event, message_id: "2", revoked: true }] });
  await receiveWechat({ account, events: [{ ...event, message_id: "2" }] });
  inbox = await wechatInbox({ account, group });
  assert.equal(inbox.messages.length, 2);
  assert.ok(inbox.messages.every((m) => m.revoked && m.content === ""));
  assert.equal(inbox.messages.find((m) => m.message_id === event.message_id)!.sender_name, event.sender_name);

  await receiveWechat({ account: other, groups: [{ id: group, name: "Other account" }], initialSince: sent });
  await receiveWechat({ account: other, events: [event] });
  const isolated = await wechatInbox({ account: other, group });
  assert.equal(isolated.messages.length, 1);
  assert.equal(isolated.messages[0]!.content, event.content);

  await pauseWechat({ account, groupId: group, enabled: false }, "Synthetic test admin");
  assert.equal((await receiveWechat({ account, events: [{ ...event, message_id: "3" }], checkpoints: [{ groupId: group, through: sent + 60 }] })).accepted, 0);
  assert.equal((await wechatStatus(account))[0]!.reconcile_through, sent + 30);
  await receiveWechat({ account, groups: [{ id: group, name: "Renamed" }], initialSince: sent - 90 });
  assert.equal((await wechatStatus(account))[0]!.enabled, false, "bridge registration cannot undo a pause");
  await pauseWechat({ account, groupId: group, enabled: true }, "Synthetic test admin");
  assert.equal((await receiveWechat({ account, events: [{ ...event, message_id: "3" }] })).accepted, 1);
  await assert.rejects(receiveWechat({ account, events: [{ ...event, group_id: "unknown@chatroom" }] }), { statusCode: 400 });
  assert.equal((await wechatInbox({ account, group })).messages.length, 3);
});

test("private table constraints reject orphan messages and revoked bodies", async () => {
  const account = `constraints_${tag()}`;
  await receiveWechat({ account, groups: [{ id: "456@chatroom", name: "Synthetic constraints" }], initialSince: 1 });
  await assert.rejects(sql`INSERT INTO wechat_messages (account, group_id, message_id, sent_at) VALUES (${account}, 'unknown@chatroom', '1', 1)`, { code: "23503" });
  await assert.rejects(sql`INSERT INTO wechat_messages (account, group_id, message_id, sent_at, revoked, content) VALUES (${account}, '456@chatroom', '1', 1, true, 'Synthetic body')`, { code: "23514" });
});
