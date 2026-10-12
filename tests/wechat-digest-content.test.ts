import assert from "node:assert/strict";
import { test } from "node:test";
import { digestChunks, digestHash, scrubWechat, summarizeWechat } from "../packages/backend/src/wechat/digest-content.ts";
import type { WechatMessage } from "@aihot/contracts/wechat";

const message = (id: string, content: string): WechatMessage => ({ message_id: id, group_id: "1@chatroom", sender_id: "member", sender_name: "真实昵称", sent_at: 100, revoked: false, content });

test("summary input covers long discussions, anonymizes speakers and removes obvious identifiers", () => {
  const long = message("1", "a".repeat(35000));
  const messages = [long, message("2", "13812345678 example@example.com"), { ...message("3", "撤回正文"), revoked: true }];
  const chunks = digestChunks(messages);
  assert.equal(chunks.flat().filter(m => m.id === "1").map(m => m.text).join(""), long.content);
  assert.ok(chunks.every(c => JSON.stringify(c).length < 12500));
  assert.ok(chunks.length > 1);
  const json = JSON.stringify(chunks);
  assert.doesNotMatch(json, /真实昵称|member|13812345678|example@example.com|撤回正文/);
  assert.match(json, /发言者1/);
  assert.match(scrubWechat("13812345678"), /手机号/);
});

test("summary rejects invented evidence and does not treat an empty discussion as an error", async () => {
  await assert.rejects(summarizeWechat([message("1", "内容")], async () => [{ title: "标题", summary: "观点", evidenceIds: ["999"] }]), /引用/);
  assert.deepEqual(await summarizeWechat([], async () => { throw new Error("must not call"); }), []);
  assert.deepEqual(await summarizeWechat([message("1", "闲聊")], async () => []), []);
});

test("multi-chunk summaries merge with valid source evidence; content changes invalidate input hash", async () => {
  const messages = Array.from({ length: 5 }, (_, i) => message(String(i + 1), "x".repeat(7000)));
  const stages: string[] = [];
  const points = await summarizeWechat(messages, async (_material, ids, stage) => {
    stages.push(stage);
    return [{ title: "核心要点", summary: "存在条件和分歧", evidenceIds: [...ids].slice(0, 12) }];
  });
  assert.ok(stages.includes("merge"));
  assert.deepEqual(new Set(points[0]!.evidenceIds), new Set(messages.map(m => m.message_id)));
  const before = digestHash(messages);
  messages[0]!.content += "修改";
  assert.notEqual(before, digestHash(messages));
});
