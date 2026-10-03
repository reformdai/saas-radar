// No DB writes: rejects callers before private data queries are reached.
import assert from "node:assert/strict";
import { after, test } from "node:test";

delete process.env.DEV_AUTH_ROLE;
process.env.AIHOT_CREDENTIALS_DIR = "/nonexistent-test-credentials";
const { buildApp } = await import("../apps/api/src/app.ts");
const { closeDb } = await import("@aihot/backend/db");
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

test("private group reads and commands reject anonymous callers with no-store", async () => {
  for (const [method, url] of [["GET", "/api/admin/wechat"], ["POST", "/api/admin/wechat/group"], ["GET", "/api/ingest/wechat/status?account=main"], ["POST", "/api/ingest/wechat"]] as const) {
    const response = await app.inject({ method, url, ...(method === "POST" ? { payload: {} } : {}) });
    assert.equal(response.statusCode, 401, url);
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("group pause rejects an authenticated development fixture without its CSRF token", async () => {
  const { config } = await import("@aihot/backend/config");
  const before = config.devAdmin;
  config.devAdmin = { displayName: "Synthetic test admin" };
  try {
    const response = await app.inject({ method: "POST", url: "/api/admin/wechat/group", payload: { account: "main", groupId: "123@chatroom", enabled: false } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers["cache-control"], "no-store");
  } finally { config.devAdmin = before; }
});
