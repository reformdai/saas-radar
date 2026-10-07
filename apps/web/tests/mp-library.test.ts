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
  const path = new URL(req.url!, "http://test.local").pathname;
  res.setHeader("content-type", "application/json");
  const article = { id: "test-mp", title: "关键词建站资料", url: "https://mp.weixin.qq.com/s/test", sourceId: "gefei", sourceName: "哥飞", publishedAt: "2026-10-01T00:00:00Z", summary: null, html: "<p>第一段</p><p>第二段</p>" };
  if (path === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "test" }));
  if (path === "/api/site/mp") return res.end(JSON.stringify({ accounts: [{ id: "gefei", name: "哥飞", count: 1, bodyCount: 1 }], items: [{ ...article, hasBody: true }], page: 1, hasMore: false }));
  if (path === "/api/site/mp/test-mp") return res.end(JSON.stringify(article));
  if (!req.headers.cookie?.includes("synthetic-session=ok")) { res.statusCode = 401; res.end("{}"); return; }
  if (path === "/api/admin/me") return res.end(JSON.stringify({ name: "测试管理员", csrf: "synthetic-csrf", dev: false }));
  if (path === "/api/admin/nav-counts") return res.end("{}");
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
test("account library lists original articles and separate research links", async () => {
 const response = await fetch(`${origin}/mp`); const html = await response.text();
 assert.equal(response.status, 200, logs); assert.match(html, /关键词建站资料/);
 assert.match(html, /公众号资料库/); assert.match(html, /\/mp\/articles\/test-mp/); assert.match(html, /引用并提问/);
});
test("account reading page renders stored paragraphs and research entry", async () => {
 const response = await fetch(`${origin}/mp/articles/test-mp`); const html = await response.text();
 assert.equal(response.status, 200, logs); assert.match(html, /<p>第一段<\/p><p>第二段<\/p>/); assert.match(html, /引用本文，开始研究/);
});
test("research page requires admin login and renders a scoped citation input after login", async () => {
 const path = '/admin/research?article=test-mp&kind=mp';
 const denied = await fetch(origin + path, { redirect: 'manual' }); assert.equal(denied.status, 302);
 const allowed = await fetch(origin + path, { headers: { cookie: 'synthetic-session=ok' } });
 assert.equal(allowed.status, 200, logs); assert.match(allowed.headers.get('cache-control')!, /no-store/);
 const html = await allowed.text(); assert.match(html, /关键词建站资料/); assert.match(html, /当前文章与全部信源/); assert.match(html, /发送问题/);
});
