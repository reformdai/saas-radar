import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireCollectorLock } from "../scripts/wechat/process-lock.ts";

test("collector process lock excludes concurrent writers and reopens without deleting a stale marker", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "wechat-node-lock-")), "collector.lock");
  const signal = new AbortController();
  let lost = false;
  const release = await acquireCollectorLock(path, signal.signal, () => { lost = true; });
  try { await assert.rejects(acquireCollectorLock(path, signal.signal), /已有采集器/); }
  finally { await release(); }
  assert.equal(lost, false);
  const again = await acquireCollectorLock(path, signal.signal);
  await again();
});

test("collector abort releases its OS lock and allows the next process to continue", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "wechat-node-lock-")), "collector.lock");
  const signal = new AbortController();
  const release = await acquireCollectorLock(path, signal.signal);
  signal.abort();
  await release();
  const again = await acquireCollectorLock(path, new AbortController().signal);
  await again();
});
