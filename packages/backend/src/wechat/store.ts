// Private group data and private digests never enter public articles/publication queues.
import { z } from "zod";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import type { WechatGroup, WechatInbox } from "@aihot/contracts/wechat";
import { digestStoreReady, invalidateWechatDigest, wechatDay } from "./digests.ts";

const account = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const groupId = z.string().regex(/^[\w-]+@chatroom$/).max(120);
const seconds = z.number().int().positive().max(4102444800);
const Intake = z.object({
  account,
  groups: z.array(z.object({ id: groupId, name: z.string().max(200) })).max(100).default([]),
  initialSince: seconds.optional(),
  events: z.array(z.object({
    group_id: groupId, group_name: z.string().max(200), message_id: z.string().regex(/^[1-9]\d{0,24}$/),
    sender_id: z.string().max(200), sender_name: z.string().max(200), content: z.string().max(100_000),
    sent_at: seconds, revoked: z.boolean(),
  })).max(50).default([]),
  checkpoints: z.array(z.object({ groupId, through: seconds })).max(100).default([]),
});

export async function receiveWechat(input: unknown) {
  const body = Intake.parse(input);
  if (!body.groups.length && !body.events.length && !body.checkpoints.length) throw Object.assign(new Error("没有群或消息"), { statusCode: 400 });
  const now = Math.floor(Date.now() / 1000);
  if ((body.initialSince ?? now) > now + 60 || body.checkpoints.some((c) => c.through > now + 60) || body.events.some((e) => e.sent_at > now + 60)) {
    throw Object.assign(new Error("消息或同步水位不能在未来"), { statusCode: 400 });
  }
  return sql.begin(async (tx) => {
    for (const g of body.groups) {
      await tx`INSERT INTO wechat_groups (account, group_id, name, reconcile_through)
        VALUES (${body.account}, ${g.id}, ${g.name || g.id}, ${body.initialSince ?? now})
        ON CONFLICT (account, group_id) DO UPDATE SET name = EXCLUDED.name`;
    }
    // Serialize registrations, pauses, SSE and poll batches for this account's groups.
    const rows = await tx<{ group_id: string; enabled: boolean }[]>`SELECT group_id, enabled FROM wechat_groups WHERE account = ${body.account} ORDER BY group_id FOR UPDATE`;
    const enabled = new Map(rows.map((g) => [g.group_id, g.enabled]));
    if ([...body.events.map((e) => e.group_id), ...body.checkpoints.map((c) => c.groupId)].some((id) => !enabled.has(id))) {
      throw Object.assign(new Error("群未登记，请先启动采集桥登记白名单"), { statusCode: 400 });
    }
    let accepted = 0;
    const digestsReady = await digestStoreReady(tx);
    const changedDays = new Map<string, { group: string; day: string }>();
    for (const e of body.events) {
      if (!enabled.get(e.group_id)) continue;
      const [previous] = await tx<{ sender_id: string; sender_name: string; content: string; sent_at: number; revoked: boolean }[]>`
        SELECT sender_id, sender_name, content, sent_at::float8 AS sent_at, revoked FROM wechat_messages
        WHERE account = ${body.account} AND group_id = ${e.group_id} AND message_id = ${e.message_id}`;
      const changed = !previous || previous.sender_id !== (e.sender_id || previous.sender_id)
        || previous.sender_name !== (e.sender_name || previous.sender_name)
        || previous.content !== (previous.revoked || e.revoked ? "" : e.content)
        || previous.sent_at !== (e.revoked ? previous.sent_at : e.sent_at)
        || previous.revoked !== (previous.revoked || e.revoked);
      await tx`INSERT INTO wechat_messages (account, group_id, message_id, sender_id, sender_name, content, sent_at, revoked)
        VALUES (${body.account}, ${e.group_id}, ${e.message_id}, ${e.sender_id}, ${e.sender_name}, ${e.revoked ? "" : e.content}, ${e.sent_at}, ${e.revoked})
        ON CONFLICT (account, group_id, message_id) DO UPDATE SET
          sender_id = COALESCE(NULLIF(EXCLUDED.sender_id, ''), wechat_messages.sender_id),
          sender_name = COALESCE(NULLIF(EXCLUDED.sender_name, ''), wechat_messages.sender_name),
          content = CASE WHEN wechat_messages.revoked OR EXCLUDED.revoked THEN '' ELSE EXCLUDED.content END,
          sent_at = CASE WHEN EXCLUDED.revoked THEN wechat_messages.sent_at ELSE EXCLUDED.sent_at END,
          revoked = wechat_messages.revoked OR EXCLUDED.revoked`;
      if (digestsReady && changed) {
        for (const timestamp of [previous?.sent_at, e.revoked && previous ? previous.sent_at : e.sent_at]) {
          if (timestamp === undefined) continue;
          const day = wechatDay(timestamp);
          changedDays.set(`${e.group_id}/${day}`, { group: e.group_id, day });
        }
      }
      await tx`UPDATE wechat_groups SET last_received_at = now(), name = COALESCE(NULLIF(${e.group_name}, ''), name)
        WHERE account = ${body.account} AND group_id = ${e.group_id}`;
      accepted++;
    }
    for (const { group, day } of changedDays.values()) await invalidateWechatDigest(tx, body.account, group, day);
    for (const checkpoint of body.checkpoints) {
      if (!enabled.get(checkpoint.groupId)) continue;
      await tx`UPDATE wechat_groups SET reconcile_through = GREATEST(reconcile_through, ${checkpoint.through}), last_checked_at = now()
        WHERE account = ${body.account} AND group_id = ${checkpoint.groupId}`;
    }
    return { ok: true, accepted };
  });
}

export async function wechatStatus(input: unknown): Promise<WechatGroup[]> {
  const key = account.parse(input);
  return sql<WechatGroup[]>`SELECT account, group_id, name, enabled, reconcile_through::float8 AS reconcile_through, last_received_at, last_checked_at
    FROM wechat_groups WHERE account = ${key} ORDER BY group_id`;
}

export async function recordWechatDiscovery(input: unknown) {
  const body = z.object({ account, groups: z.array(z.object({ id: groupId, name: z.string().max(200) })).max(100) }).parse(input);
  await sql.begin(async (tx) => {
    for (const g of body.groups) await tx`INSERT INTO wechat_group_catalog (account, group_id, name)
      VALUES (${body.account}, ${g.id}, ${g.name || g.id})
      ON CONFLICT (account, group_id) DO UPDATE SET name = EXCLUDED.name, last_seen_at = now()`;
  });
  return { ok: true, discovered: body.groups.length };
}

export async function wechatCollectorConfig(input: unknown) {
  const key = account.parse(input);
  const groups = await sql<{ id: string; name: string }[]>`SELECT c.group_id AS id, c.name
    FROM wechat_group_catalog c LEFT JOIN wechat_groups g USING (account, group_id)
    WHERE c.account = ${key} AND c.selected AND COALESCE(g.enabled, true)
    ORDER BY c.group_id`;
  return { groups };
}

export async function selectWechatGroup(input: unknown, actor: string) {
  const b = z.object({ account, groupId, selected: z.boolean() }).parse(input);
  return sql.begin(async (tx) => {
    const [candidate] = await tx<{ name: string; selected: boolean }[]>`SELECT name, selected FROM wechat_group_catalog
      WHERE account = ${b.account} AND group_id = ${b.groupId} FOR UPDATE`;
    if (!candidate) throw Object.assign(new Error("群尚未被本机采集器发现"), { statusCode: 400 });
    await tx`UPDATE wechat_group_catalog SET selected = ${b.selected} WHERE account = ${b.account} AND group_id = ${b.groupId}`;
    const [existing] = await tx<{ enabled: boolean }[]>`SELECT enabled FROM wechat_groups WHERE account = ${b.account} AND group_id = ${b.groupId} FOR UPDATE`;
    if (existing) await tx`UPDATE wechat_groups SET enabled = ${b.selected} WHERE account = ${b.account} AND group_id = ${b.groupId}`;
    await audit(actor, b.selected ? "wechat.select" : "wechat.deselect", `wechat:${b.account}:${b.groupId}`, null,
      { selected: candidate.selected, enabled: existing?.enabled ?? null }, { selected: b.selected, enabled: existing ? b.selected : null }, { db: tx });
    return { ok: true };
  });
}

export async function wechatInbox(query: Record<string, unknown>): Promise<WechatInbox> {
  const [schema] = await sql<{ ready: boolean }[]>`SELECT to_regclass('wechat_groups') IS NOT NULL AND to_regclass('wechat_messages') IS NOT NULL AND to_regclass('wechat_group_catalog') IS NOT NULL AS ready`;
  if (!schema?.ready) return { ready: false, groups: [], candidates: [], messages: [], hasMore: false };
  const candidates = await sql<WechatInbox["candidates"]>`SELECT account, group_id, name, selected, last_seen_at
    FROM wechat_group_catalog ORDER BY selected DESC, name, account`;
  const groups = await sql<WechatGroup[]>`SELECT g.account, g.group_id, g.name, g.enabled, g.reconcile_through::float8 AS reconcile_through, g.last_received_at, g.last_checked_at,
    (SELECT count(*)::int FROM wechat_messages m WHERE m.account = g.account AND m.group_id = g.group_id) AS message_count
    FROM wechat_groups g ORDER BY g.name, g.account`;
  const selected = groups.find((g) => g.account === query.account && g.group_id === query.group) ?? (query.group ? null : groups[0]);
  if (!selected) return { ready: true, groups, candidates, messages: [], hasMore: false };
  const page = Math.max(1, Math.min(10000, Number(query.page) || 1));
  const messages = await sql<WechatInbox["messages"]>`SELECT message_id, group_id, sender_id, sender_name, content, sent_at::float8 AS sent_at, revoked FROM wechat_messages
    WHERE account = ${selected.account} AND group_id = ${selected.group_id}
    ORDER BY sent_at DESC, message_id DESC LIMIT 101 OFFSET ${(Math.floor(page) - 1) * 100}`;
  return { ready: true, groups, candidates, messages: messages.slice(0, 100), hasMore: messages.length > 100 };
}

export async function pauseWechat(input: unknown, actor: string) {
  const b = z.object({ account, groupId, enabled: z.boolean() }).parse(input);
  return sql.begin(async (tx) => {
    const [before] = await tx<{ enabled: boolean }[]>`SELECT enabled FROM wechat_groups WHERE account = ${b.account} AND group_id = ${b.groupId} FOR UPDATE`;
    if (!before) throw Object.assign(new Error("群不存在"), { statusCode: 400 });
    await tx`UPDATE wechat_groups SET enabled = ${b.enabled} WHERE account = ${b.account} AND group_id = ${b.groupId}`;
    await audit(actor, b.enabled ? "wechat.resume" : "wechat.pause", `wechat:${b.account}:${b.groupId}`, null, before, { enabled: b.enabled }, { db: tx });
    return { ok: true };
  });
}
