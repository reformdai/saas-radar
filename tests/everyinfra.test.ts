import assert from "node:assert/strict";
import { test } from "node:test";
import { everyinfraCost, everyinfraPosts } from "../packages/backend/src/providers/everyinfra.ts";
import { unsupportedConfig } from "../packages/backend/src/sources/config-keys.ts";

test("account listings retain sibling article identities and parse UTC timestamps", () => {
  const posts = everyinfraPosts({ results: [1, 2].map((idx) => ({
    id: 123, title: `文章 ${idx}`, url: `https://mp.weixin.qq.com/s?mid=123&idx=${idx}&sn=identity${idx}`,
    posted_at: "2026-10-01T15:58:38+00:00", position: idx,
  })) });
  assert.equal(posts.length, 2);
  assert.equal(posts[0]!.post_time, Date.parse("2026-10-01T15:58:38Z") / 1000);
  assert.notEqual(posts[0]!.url, posts[1]!.url);
  assert.deepEqual(posts.map((p) => p.sn), ["identity1", "identity2"]);
});

test("invalid and deleted results cannot become account articles", () => {
  const posts = everyinfraPosts({ results: [null, { title: "bad", url: "javascript:alert(1)" },
    { title: "bad", url: "https://example.com" }, { title: "", url: "https://mp.weixin.qq.com/s/a" },
    { title: "deleted", url: "https://mp.weixin.qq.com/s/a", is_deleted: true },
    { title: "unknown time", url: "https://mp.weixin.qq.com/s/b", posted_at: "not a date" }] });
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.post_time, 0);
  assert.throws(() => everyinfraPosts({}), /missing results array/);
  assert.deepEqual(everyinfraPosts({ results: [] }), []);
});

test("cost uses exact charged base currency rather than rounded CNY display", () => {
  assert.deepEqual(everyinfraCost({ billing: { charged: true, amount: { base: "USD", amount: 0.00555556 } } }),
    { amount: 0.00555556, currency: "USD", basis: "actual" });
  assert.deepEqual(everyinfraCost({ billing: { charged: false } }), { amount: 0, currency: "USD", basis: "actual" });
  assert.equal(everyinfraCost({}), null);
  assert.equal(everyinfraCost({ billing: { amount: { base: "USD", amount: -1 } } }), null);
});

test("both list providers are supported without changing legacy account configuration", () => {
  assert.deepEqual(unsupportedConfig("mp_account", { ghid: "gefei7", nickname: "哥飞" }), []);
  for (const listProvider of ["dajiala", "everyinfra"]) assert.deepEqual(unsupportedConfig("mp_account", { ghid: "gefei7", listProvider }), []);
  assert.deepEqual(unsupportedConfig("mp_account", { listProvider: "unknown" }), ["listProvider=unknown"]);
});
