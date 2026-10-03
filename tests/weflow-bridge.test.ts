import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { WechatGroup, WechatIntake } from "@aihot/contracts/wechat";
import { pushEvent, sseEvents, WeFlowBridge, weflowBase } from "../packages/backend/src/wechat/bridge.ts";

const group = "123@chatroom", other = "456@chatroom", bigId = "18446744073709551615";
const row: WechatGroup = { account: "main", group_id: group, name: "测试群", enabled: true, reconcile_through: 1000, last_received_at: null, last_checked_at: null };

async function serve(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
function fixture(fetcher?: typeof fetch) {
  const calls: WechatIntake[] = [];
  const bridge = new WeFlowBridge({ baseUrl: "http://127.0.0.1:5031", token: "synthetic-token", account: "main", groups: [group], initialSince: 1000, now: () => 1200_000, fetch: fetcher,
    sink: { send: async (body) => { calls.push(body); }, status: async () => [row] },
  });
  return { bridge, calls };
}

test("SSE decoder preserves split UTF-8, CRLF, multiline data and rejects an incomplete final event", async () => {
  const complete = `: heartbeat\r\nevent: message.new\r\ndata: {"content":"出海",\r\ndata: "rawid":"${bigId}"}\r\n\r\n`;
  const bytes = new TextEncoder().encode(complete + "event: message.new\ndata: {\"content\":\"truncated\"}");
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i++) c.enqueue(bytes.slice(i, i + 1)); c.close(); } });
  const events = [];
  for await (const event of sseEvents(stream)) events.push(event);
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0].data), { content: "出海", rawid: bigId });
});

test("SSE ignores private chats and unselected groups, preserves 64-bit IDs and removes revoked text", () => {
  const payload = { sessionId: group, groupName: "测试群", sourceName: "测试成员", rawid: bigId, content: "原文", timestamp: 1100 };
  const groups = new Set([group]);
  assert.equal(pushEvent("message.new", { ...payload, sessionId: "wxid_private" }, groups), null);
  assert.equal(pushEvent("message.new", { ...payload, sessionId: other }, groups), null);
  assert.equal(pushEvent("message.new", { ...payload, rawid: Number(bigId) }, groups), null);
  assert.equal(pushEvent("message.new", { ...payload, rawid: "未知" }, groups), null);
  assert.equal(pushEvent("message.new", payload, groups)?.message_id, bigId);
  assert.equal(pushEvent("message.revoke", payload, groups)?.content, "");
  assert.equal(pushEvent("message.revoke", payload, groups)?.revoked, true);
});

test("loopback endpoint validation does not accept credentialed, remote or redirect-style URLs", () => {
  assert.equal(weflowBase("http://127.0.0.1:5031"), "http://127.0.0.1:5031");
  for (const url of ["https://example.com", "http://user:pass@127.0.0.1:5031", "http://127.0.0.1:5031/path", "http://127.0.0.1:5031?token=secret", "http://127.0.0.1.example.com"]) assert.throws(() => weflowBase(url));
});

test("fixed-window pagination stores every page before committing its checkpoint", async () => {
  const seen: URL[] = [];
  const { bridge, calls } = fixture(async (input, init) => {
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer synthetic-token");
    assert.equal(init?.redirect, "error");
    const url = new URL(String(input)); seen.push(url);
    const second = url.searchParams.get("offset") === "2";
    return Response.json({ success: true, hasMore: !second, messages: second ? [{ serverId: "3", createTime: 1190, content: "第三条" }] : [{ serverId: bigId, createTime: 1000, content: "第一条" }, { serverId: "2", createTime: 1000, content: "同秒第二条" }] });
  });
  await bridge.reconcile(new AbortController().signal);
  assert.deepEqual(seen.map((u) => [u.searchParams.get("start"), u.searchParams.get("end"), u.searchParams.get("offset")]), [["940", "1200", "0"], ["940", "1200", "2"]]);
  assert.equal(calls.flatMap((b) => b.events ?? []).length, 3);
  assert.equal(calls[0].events?.[0].message_id, bigId);
  assert.deepEqual(calls.at(-1)?.checkpoints, [{ groupId: group, through: 1200 }]);
});

test("a failed later page and a non-advancing page never commit the checkpoint", async () => {
  for (const broken of ["http", "empty", "outside"] as const) {
    let n = 0;
    const { bridge, calls } = fixture(async () => {
      if (++n === 1) return Response.json({ success: true, hasMore: true, messages: [{ serverId: "1", createTime: 1100, content: "保留" }] });
      if (broken === "http") return new Response("error", { status: 503 });
      return Response.json({ success: true, hasMore: true, messages: broken === "empty" ? [] : [{ serverId: "2", createTime: 1500, content: "越界" }] });
    });
    await assert.rejects(bridge.reconcile(new AbortController().signal));
    assert.equal(calls.some((b) => b.checkpoints), false);
    assert.equal(calls[0].events?.[0].content, "保留");
  }
});

test("an intake failure cannot advance a successful query's checkpoint", async () => {
  const checkpoints: WechatIntake[] = [];
  const bridge = new WeFlowBridge({ baseUrl: "http://127.0.0.1:5031", token: "synthetic-token", account: "main", groups: [group], initialSince: 1000, now: () => 1200_000,
    fetch: async () => Response.json({ success: true, hasMore: false, messages: [{ serverId: "1", createTime: 1100, content: "测试" }] }),
    sink: { send: async (body) => { if (body.events) throw new Error("intake unavailable"); checkpoints.push(body); }, status: async () => [row] },
  });
  await assert.rejects(bridge.reconcile(new AbortController().signal));
  assert.deepEqual(checkpoints, []);
});

test("paused and unselected groups are not queried", async () => {
  let queried = 0;
  const bridge = new WeFlowBridge({ baseUrl: "http://127.0.0.1:5031", token: "synthetic-token", account: "main", groups: [group], initialSince: 1000,
    fetch: async () => { queried++; return Response.json({}); }, sink: { send: async () => {}, status: async () => [{ ...row, enabled: false }, { ...row, group_id: other }] },
  });
  await bridge.reconcile(new AbortController().signal);
  assert.equal(queried, 0);
});

test("real HTTP SSE only forwards the whitelist, reconnects and exits on cancellation", async () => {
  let connections = 0, polling = 0;
  const controller = new AbortController();
  const calls: WechatIntake[] = [];
  const server = await serve((req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-token");
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/api/v1/sessions") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ success: true, sessions: [{ username: group, displayName: "测试群" }] })); return; }
    if (url.pathname === "/api/v1/messages") { polling++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ success: true, hasMore: false, messages: [] })); return; }
    connections++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const sessionId of ["wxid_private", other, group]) {
      const data = { sessionId, rawid: bigId, groupName: "测试群", sourceName: "成员", timestamp: 1100, content: `来自${sessionId}` };
      res.write(`event: message.new\ndata: ${JSON.stringify(data)}\n\n`);
    }
    res.end();
  });
  const bridge = new WeFlowBridge({ baseUrl: server.url, token: "synthetic-token", account: "main", groups: [group], initialSince: 1000, now: () => 1200_000, pollMs: 50,
    sink: { send: async (body) => { calls.push(body); if (body.events && connections >= 2) controller.abort(); }, status: async () => [row] },
  });
  const timeout = setTimeout(() => controller.abort(), 10000);
  try { await bridge.run(controller.signal); }
  finally { clearTimeout(timeout); await server.close(); }
  assert.equal(connections, 2);
  assert.ok(polling >= 2);
  assert.ok(calls.flatMap((c) => c.events ?? []).every((e) => e.group_id === group));
  assert.ok(calls.some((c) => c.groups?.[0].id === group));
});
