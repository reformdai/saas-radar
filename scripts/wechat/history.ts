import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { z } from "zod";
import { LocalRead, localBatch, deliverLocalBatch } from "../../packages/backend/src/wechat/local.ts";
import type { WechatIntake } from "@aihot/contracts/wechat";

const position = z.object({ scope: z.string().min(1).max(300), time: z.number().int().nonnegative(),
  local: z.number().int().nonnegative(), done: z.boolean() });
const HistoryBatch = LocalRead.extend({ rows: LocalRead.shape.rows.max(250), position });
type Position = z.infer<typeof position>;
interface HistoryState {
  version: 1;
  account: string;
  destination: string;
  identity: string;
  groups: string[];
  positions: Record<string, Position>;
  uploaded: number;
  pending: number;
  unresolvedGroups: string[];
  complete: boolean;
}
const save = (path: string, state: HistoryState) => {
  writeFileSync(`${path}.next`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${path}.next`, path);
};

async function* historyLines(stream: Readable) {
  stream.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    if (buffer.length > 100_000_000) throw new Error("历史批次超过传输上限，成功进度已保存");
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) throw new Error("历史输出批次不完整，成功进度已保存");
}

export async function runLocalHistory(options: { args: string[]; account: string; groups: string[];
  destination: string; statePath: string; signal: AbortSignal; send: (body: WechatIntake) => Promise<void> }) {
  const { account, groups, destination, statePath, signal, send } = options;
  let state: HistoryState | undefined;
  if (existsSync(statePath)) {
    state = JSON.parse(readFileSync(statePath, "utf8")) as HistoryState;
    if (state.version !== 1 || state.account !== account || state.destination !== destination
      || JSON.stringify(state.groups) !== JSON.stringify(groups) || !state.positions || !state.identity
      || !Array.isArray(state.unresolvedGroups) || !Number.isSafeInteger(state.uploaded) || !Number.isSafeInteger(state.pending)) {
      throw new Error("历史进度与账号、接收站点或已选群不一致，请使用新的历史进度文件");
    }
    if (state.complete) {
      console.log(JSON.stringify({ historyComplete: true, selected: groups.length, uploaded: state.uploaded,
        pending: state.pending, incompleteGroups: state.unresolvedGroups.length }));
      return;
    }
  }
  const child = spawn(process.env.WECHAT_PYTHON || "python3", [...options.args, "--stream", "--since", "1",
    "--resume", statePath, ...groups.flatMap(g => ["--group", g])], { signal, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = "";
  child.stderr.on("data", data => {
    const line = String(data).split("\n").find(line => line.startsWith("READER_ERROR: "));
    if (line) diagnostic = line.slice(14, 314);
  });
  // Install completion handlers before consuming stdout, so fast exits cannot be missed.
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  void exited.catch(() => {});
  let finished = false;
  let registered = false;
  try {
    for await (const line of historyLines(child.stdout)) {
      const data = JSON.parse(line);
      if (data.complete === true) {
        if (state && state.identity !== data.identity) throw new Error("历史源账号身份变化");
        finished = true;
        continue;
      }
      const batch = HistoryBatch.parse(data);
      state ??= { version: 1, account, destination, identity: batch.identity, groups, positions: {},
        uploaded: 0, pending: 0, unresolvedGroups: [], complete: false };
      if (state.identity !== batch.identity) throw new Error("历史源账号身份变化");
      const events = localBatch(batch, { version: 1, account, destination, identity: state.identity, groups,
        since: 1, seen: {}, ids: {} });
      // A scanned page is not a full-group checkpoint. Advance only the private scan cursor.
      await deliverLocalBatch(account, batch.groups, 1, events.events, Math.floor(Date.now() / 1000), async body => {
        if (body.groups && registered) return;
        await send(body);
        if (body.groups) registered = true;
      }, groups);
      const next: HistoryState = { ...state, positions: { ...state.positions, [batch.position.scope]: batch.position },
        uploaded: state.uploaded + events.events.length, pending: state.pending + events.pending,
        unresolvedGroups: [...new Set([...state.unresolvedGroups, ...events.unresolvedGroups])] };
      save(statePath, next);
      state = next;
      console.log(JSON.stringify({ historyProgress: true, uploaded: state.uploaded, pending: state.pending,
        completedTables: Object.values(state.positions).filter(p => p.done).length,
        checkedAt: new Date().toISOString() }));
    }
    const code = await exited;
    if (code !== 0 || !finished || !state) throw new Error(diagnostic || "历史读取未完成，已保存成功批次的进度");
    const checkpoints = groups.filter(g => !state!.unresolvedGroups.includes(g)).map(groupId => ({ groupId, through: Math.floor(Date.now() / 1000) }));
    if (checkpoints.length) await send({ account, checkpoints });
    state.complete = true;
    save(statePath, state);
    console.log(JSON.stringify({ historyComplete: true, selected: groups.length, uploaded: state.uploaded,
      pending: state.pending, incompleteGroups: state.unresolvedGroups.length }));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited.catch(() => {});
  }
}
