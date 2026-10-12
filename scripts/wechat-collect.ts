// Run on the Mac hosting WeChat. All runtime code is owned by this repository.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { LocalRead, localBatch, deliverLocalBatch, deliverLocalDiscovery, type LocalState } from "../packages/backend/src/wechat/local.ts";
import type { WechatGroup } from "@aihot/contracts/wechat";
import { acquireCollectorLock } from "./wechat/process-lock.ts";

const { values } = parseArgs({ options: {
  "db-dir": { type: "string" }, "key-file": { type: "string" }, "sqlcipher-lib": { type: "string" },
  group: { type: "string", multiple: true }, account: { type: "string", default: "main" },
  since: { type: "string" }, state: { type: "string" }, interval: { type: "string", default: "600" },
  "list-groups": { type: "boolean" }, once: { type: "boolean" }, help: { type: "boolean" },
  managed: { type: "boolean" },
} });

if (values.help) {
  console.log("用法：node scripts/wechat-collect.ts --db-dir /明确账号/db_storage --key-file /独立目录/keys.json --list-groups\n采集：增加 --group 群ID@chatroom --state /独立目录/state.json [--since ISO时间] [--once]\n采集需 WECHAT_LOCAL_ENABLED=true、COLLECT_ENABLED=true、INGEST_TOKEN；接收地址 SHIPRADAR_INGEST_URL（默认 http://127.0.0.1:3001）。默认每 600 秒读取，首次默认最近 7 天，之后保持原接入起点。详见 docs/wechat-local.md。");
} else {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    if (process.env.WECHAT_LOCAL_ENABLED !== "true" || process.env.COLLECT_ENABLED !== "true") throw new Error("需显式开启 WECHAT_LOCAL_ENABLED=true 和 COLLECT_ENABLED=true");
    if (!values["db-dir"] || !values["key-file"]) throw new Error("需要明确的 --db-dir 和 --key-file");
    const reader = fileURLToPath(new URL("./wechat/reader.py", import.meta.url));
    const account = values.account!;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(account)) throw new Error("account 格式错误");
    const groups = [...new Set(values.group ?? [])].sort();
    if (groups.some(g => !/^[\w-]+@chatroom$/.test(g))) throw new Error("群 ID 格式错误");
    const args = [reader, "--root", resolve(values["db-dir"]), "--keys", resolve(values["key-file"])];
    if (values["sqlcipher-lib"]) args.push("--library", resolve(values["sqlcipher-lib"]));
    const read = async (since: number, selected: string[], listing = false) => {
      const childArgs = [...args, "--since", String(since), ...selected.flatMap(g => ["--group", g])];
      if (values["list-groups"] || listing) childArgs.push("--list-groups");
      try {
        const { stdout } = await promisify(execFile)(process.env.WECHAT_PYTHON || "python3", childArgs,
          { maxBuffer: 64 * 1024 * 1024, timeout: 240_000, signal: controller.signal });
        return LocalRead.parse(JSON.parse(stdout));
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr ?? "";
        const detail = stderr.split("\n").find(line => line.startsWith("READER_ERROR: "));
        throw new Error(detail?.slice(14, 314) ?? "本地读取失败，未提交本批。请检查路径、SQLCipher/Python 版本或消息编码；未输出正文或凭据。");
      }
    };
    if (values["list-groups"]) {
      for (const g of (await read(1, [])).groups) console.log(`${g.id}\t${g.name}`);
    } else {
      if ((!groups.length && !values.managed) || !values.state) throw new Error("需要 --group 白名单（或 --managed）和 --state 独立状态文件");
      const destination = new URL(process.env.SHIPRADAR_INGEST_URL || "http://127.0.0.1:3001");
      if (destination.username || destination.password || destination.search || destination.hash || destination.pathname !== "/" || !(destination.protocol === "https:" || destination.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "host.docker.internal"].includes(destination.hostname))) throw new Error("接收地址必须是 HTTPS、本机 HTTP 或 Docker 宿主地址");
      const token = process.env.INGEST_TOKEN || "";
      if (token.length < 16 || /[\r\n]/.test(token)) throw new Error("需要接收服务的 INGEST_TOKEN（至少 16 位）");
      const statePath = resolve(values.state);
      mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
      releaseLock = await acquireCollectorLock(`${statePath}.lock`, controller.signal, () => {
        console.error("采集状态锁意外释放，已停止采集"); controller.abort(); process.exitCode = 1;
      });
      const seconds = Number(values.interval);
      if (!Number.isInteger(seconds) || seconds < 60) throw new Error("interval 最小 60 秒");
      let state: LocalState | undefined;
      if (existsSync(statePath)) {
        state = JSON.parse(readFileSync(statePath, "utf8")) as LocalState;
        if (state.version !== 1 || state.account !== account || state.destination !== destination.origin || (!values.managed && JSON.stringify(state.groups) !== JSON.stringify(groups)) || !state.ids || !state.seen || !Number.isSafeInteger(state.since) || state.since < 1) throw new Error("状态文件与账号/接收服务/群白名单不匹配，请指定新的状态文件");
      }
      const since = state?.since ?? Math.floor(values.since ? Date.parse(values.since) / 1000 : Date.now() / 1000 - 7 * 86400);
      if (!Number.isSafeInteger(since) || since < 1 || since > Date.now() / 1000 || values.since && state && Math.floor(Date.parse(values.since) / 1000) !== state.since) throw new Error("接入起点无效或与已有状态不一致");
      const request = async (path: string, body?: unknown) => {
        const response = await fetch(`${destination.origin}${path}`, { method: body ? "POST" : "GET", redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) });
        if (!response.ok) throw new Error(`接收服务请求失败 (${response.status})`);
        return response.json();
      };
      do {
        try {
          let activeGroups = groups;
          if (values.managed) {
            const catalog = await read(1, [], true);
            await deliverLocalDiscovery(account, catalog.groups, body => request("/api/ingest/wechat/discovery", body));
            const config = await request(`/api/ingest/wechat/config?account=${encodeURIComponent(account)}`) as { groups: Array<{ id: string; name: string }> };
            activeGroups = config.groups.map(g => g.id).sort();
            if (!activeGroups.length) {
              console.log(JSON.stringify({ ok: true, discovered: catalog.groups.length, selected: 0, checkedAt: new Date().toISOString() }));
              if (!values.once) await delay(seconds * 1000, undefined, { signal: controller.signal });
              continue;
            }
          } else {
            const known = (await request(`/api/ingest/wechat/status?account=${encodeURIComponent(account)}`) as { groups: WechatGroup[] }).groups;
            if (known.some(g => groups.includes(g.group_id) && !g.enabled)) throw new Error("白名单中有已暂停的群；本轮暂停采集，不推进状态");
          }
          const through = Math.floor(Date.now() / 1000);
          const result = await read(since, activeGroups);
          if (state && state.identity !== result.identity) throw new Error("账号目录已变化，拒绝沿用旧采集状态");
          state ??= { version: 1, identity: result.identity, account, destination: destination.origin, groups: activeGroups, since, seen: {}, ids: {} };
          const currentState = values.managed ? { ...state, groups: activeGroups } : state;
          const batch = localBatch(result, currentState);
          await deliverLocalBatch(account, result.groups, since, batch.events, through, async body => {
            const response = await request("/api/ingest/wechat", body) as { accepted?: number };
            if (body.events && response.accepted !== body.events.length) throw new Error("接收期间群被暂停；保留状态等待重试");
          });
          writeFileSync(`${statePath}.next`, JSON.stringify(batch.next), { mode: 0o600 });
          renameSync(`${statePath}.next`, statePath);
          state = batch.next;
          console.log(JSON.stringify({ ok: true, changed: batch.events.length, pending: batch.pending, checkedAt: new Date().toISOString() }));
        } catch (error) {
          if (controller.signal.aborted) break;
          console.error(error instanceof Error ? error.message : "采集失败，保留进度");
          if (values.once) { process.exitCode = 1; break; }
        }
        if (!values.once) await delay(seconds * 1000, undefined, { signal: controller.signal });
      } while (!values.once && !controller.signal.aborted);
    }
  } catch (error) {
    if (!controller.signal.aborted) { console.error(error instanceof Error ? error.message : "采集失败"); process.exitCode = 1; }
  } finally {
    if (releaseLock) await releaseLock();
  }
}
