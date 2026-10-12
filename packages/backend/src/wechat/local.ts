import { createHash } from "node:crypto";
import { z } from "zod";
import type { WechatEvent, WechatIntake } from "@aihot/contracts/wechat";

const group = z.string().regex(/^[\w-]+@chatroom$/).max(120);
export const LocalRead = z.object({
  identity: z.string().min(1), groups: z.array(z.object({ id: group, name: z.string().max(200) })).max(10_000),
  pending: z.number().int().nonnegative(),
  rows: z.array(z.object({ local: z.string().min(1).max(300), target: z.string().regex(/^\d*$/),
    event: z.object({ group_id: group, group_name: z.string().max(200), message_id: z.string().regex(/^\d+$/),
      sender_id: z.string().max(200), sender_name: z.string().max(200), content: z.string().max(100_000),
      sent_at: z.number().int().positive().max(4102444800), revoked: z.boolean() }),
  })).max(200_000),
});

export interface LocalState {
  version: 1;
  identity: string;
  account: string;
  destination: string;
  groups: string[];
  since: number;
  // Hashes and exact server IDs only, no message bodies or keys.
  seen: Record<string, string>;
  ids: Record<string, string>;
}

export async function deliverLocalDiscovery(account: string, groups: Array<{ id: string; name: string }>,
  send: (body: { account: string; groups: Array<{ id: string; name: string }> }) => Promise<unknown>): Promise<void> {
  for (let offset = 0; offset < groups.length; offset += 100) {
    await send({ account, groups: groups.slice(offset, offset + 100) });
  }
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = (value: string) => /^[1-9]\d{0,24}$/.test(value);

/** No time cursor: compare the whole configured intake range, including late/edited rows. */
export function localBatch(input: unknown, state: LocalState): { events: WechatEvent[]; next: LocalState; pending: number } {
  const read = LocalRead.parse(input);
  if (read.identity !== state.identity) throw new Error("账号目录已变化，拒绝沿用旧采集状态");
  if (JSON.stringify(read.groups.map(g => g.id).sort()) !== JSON.stringify([...state.groups].sort())) throw new Error("读取结果与群白名单不一致");
  const next: LocalState = { ...state, seen: { ...state.seen }, ids: { ...state.ids } };
  const candidates = new Map<string, WechatEvent>();
  // Establish all normal identities before resolving in-place revocations.
  for (const row of read.rows) {
    if (!state.groups.includes(row.event.group_id) || !row.local.startsWith(`${row.event.group_id}/`)) throw new Error("消息群身份冲突");
    if (!row.event.revoked && validId(row.event.message_id)) next.ids[row.local] = row.event.message_id;
  }
  for (const row of read.rows) {
    const event = { ...row.event };
    if (event.revoked) {
      // A system row's own server_id is not proof of the revoked target's identity.
      event.message_id = row.target || next.ids[row.local] || "";
      if (!validId(event.message_id)) throw new Error("撤回消息缺少可验证的目标 ID，本批未提交");
      event.content = "";
    } else if (!validId(event.message_id)) {
      if (event.message_id === "0") continue; // Pending sends are picked up on the next full scan.
      throw new Error("消息 ID 超出接收范围");
    }
    const key = `${event.group_id}/${event.message_id}`;
    const previous = candidates.get(key);
    if (previous?.revoked) continue;
    if (previous && !event.revoked && hash(previous) !== hash(event)) throw new Error("同一消息 ID 在分片间内容冲突，本批未提交");
    candidates.set(key, event);
  }
  const events: WechatEvent[] = [];
  for (const [key, event] of candidates) {
    const digest = hash(event);
    if (state.seen[key] !== digest) events.push(event);
    next.seen[key] = digest;
  }
  events.sort((a, b) => a.sent_at - b.sent_at || a.group_id.localeCompare(b.group_id) || (BigInt(a.message_id) < BigInt(b.message_id) ? -1 : 1));
  return { events, next, pending: read.pending };
}

/** State is saved by the caller only after every POST and its checkpoint succeed. */
export async function deliverLocalBatch(account: string, groups: Array<{ id: string; name: string }>, since: number, events: WechatEvent[], through: number, send: (body: WechatIntake) => Promise<void>) {
  await send({ account, groups, initialSince: since });
  // Keep each request comfortably within the API's body limit even for long messages.
  let batch: WechatEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (batch.length && (batch.length === 50 || bytes + size > 600_000)) {
      await send({ account, events: batch }); batch = []; bytes = 0;
    }
    batch.push(event); bytes += size;
  }
  if (batch.length) await send({ account, events: batch });
  await send({ account, checkpoints: groups.map(g => ({ groupId: g.id, through })) });
}
