// Production SSR with synthetic data: no real chats, credentials or database.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";

let ready = true;
let origin = "", logs = "";
let web: ChildProcess;
const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://test.local");
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "test" }));
  if (!req.headers.cookie?.includes("synthetic-session=ok")) { res.statusCode = 401; res.end("{}"); return; }
  if (url.pathname === "/api/admin/me") return res.end(JSON.stringify({ name: "测试管理员", csrf: "synthetic-csrf", dev: false }));
  if (url.pathname === "/api/admin/nav-counts") return res.end("{}");
  if (url.pathname === "/api/admin/wechat") return res.end(JSON.stringify({ ready, groups: ready ? [{ account: "main", group_id: "123@chatroom", name: "SaaS 测试群", enabled: true, reconcile_through: 1760000000, last_received_at: new Date().toISOString(), last_checked_at: new Date().toISOString(), message_count: 2 }] : [], messages: ready ? [
    { group_id: "123@chatroom", message_id: "18446744073709551615", sender_id: "member", sender_name: "测试成员", content: "出海案例 <script>alert(1)</script>", sent_at: 1760000000, revoked: false },
    { group_id: "123@chatroom", message_id: "2", sender_id: "member", sender_name: "测试成员", content: "", sent_at: 1759999999, revoked: true },
  ] : [], hasMore: false }));
  res.statusCode = 404; res.end("{}");
});
before(async () => {
  api.listen(0, "127.0.0.1"); await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], { env: { ...process.env, NODE_ENV: "production", WEB_HOST: "127.0.0.1", WEB_PORT: "0", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`web start timed out: ${logs}`)), 15000);
    web.on("exit", () => { clearTimeout(timer); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", (c) => { logs += String(c); });
    web.stdout!.on("data", (c) => { logs += String(c); const m = logs.match(/"msg":"web started","port":(\d+)/); if (m) { origin = `http://127.0.0.1:${m[1]}`; clearTimeout(timer); resolve(); } });
  });
});
after(async () => {
  if (web && web.exitCode === null) { web.kill("SIGTERM"); await once(web, "exit"); }
  api.closeAllConnections(); await new Promise<void>((resolve) => api.close(() => resolve()));
});
test("private group SSR renders escaped content and revoked markers without public caching", async () => {
  const response = await fetch(`${origin}/admin/wechat`, { headers: { cookie: "synthetic-session=ok" } });
  assert.equal(response.status, 200, logs);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.match(response.headers.get("x-robots-tag")!, /noindex/);
  const html = await response.text();
  assert.match(html, /SaaS 测试群/);
  assert.match(html, /出海案例 &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /这条消息已撤回/);
  assert.match(html, /暂停接收/);
});
test("signed-out group page redirects to login without returning message content", async () => {
  const response = await fetch(`${origin}/admin/wechat`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location")!, /^\/admin\/login\?/);
  assert.match(response.headers.get("cache-control")!, /no-store/);
  assert.doesNotMatch(await response.text(), /SaaS 测试群|出海案例/);
});
test("an uninitialized private store is an explicit setup state, not an empty synchronized inbox", async () => {
  ready = false;
  const response = await fetch(`${origin}/admin/wechat`, { headers: { cookie: "synthetic-session=ok" } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /群聊数据表尚未初始化/);
});
