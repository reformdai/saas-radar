// Private group data has no relationship to articles/publications or AI queues.
import { z } from "zod";
import { sql } from "../db.ts";
import { audit } from "../audit.ts";
import type { WechatGroup, WechatInbox } from "@aihot/contracts/wechat";

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
    for (const e of body.events) {
      if (!enabled.get(e.group_id)) continue;
      await tx`INSERT INTO wechat_messages (account, group_id, message_id, sender_id, sender_name, content, sent_at, revoked)
        VALUES (${body.account}, ${e.group_id}, ${e.message_id}, ${e.sender_id}, ${e.sender_name}, ${e.revoked ? "" : e.content}, ${e.sent_at}, ${e.revoked})
        ON CONFLICT (account, group_id, message_id) DO UPDATE SET
          sender_id = COALESCE(NULLIF(EXCLUDED.sender_id, ''), wechat_messages.sender_id),
          sender_name = COALESCE(NULLIF(EXCLUDED.sender_name, ''), wechat_messages.sender_name),
          content = CASE WHEN wechat_messages.revoked OR EXCLUDED.revoked THEN '' ELSE EXCLUDED.content END,
          sent_at = CASE WHEN EXCLUDED.revoked THEN wechat_messages.sent_at ELSE EXCLUDED.sent_at END,
          revoked = wechat_messages.revoked OR EXCLUDED.revoked`;
      await tx`UPDATE wechat_groups SET last_received_at = now(), name = COALESCE(NULLIF(${e.group_name}, ''), name)
        WHERE account = ${body.account} AND group_id = ${e.group_id}`;
      accepted++;
    }
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

export async function wechatInbox(query: Record<string, unknown>): Promise<WechatInbox> {
  const [schema] = await sql<{ ready: boolean }[]>`SELECT to_regclass('wechat_groups') IS NOT NULL AND to_regclass('wechat_messages') IS NOT NULL AS ready`;
  if (!schema?.ready) return { ready: false, groups: [], messages: [], hasMore: false };
  const groups = await sql<WechatGroup[]>`SELECT g.account, g.group_id, g.name, g.enabled, g.reconcile_through::float8 AS reconcile_through, g.last_received_at, g.last_checked_at,
    (SELECT count(*)::int FROM wechat_messages m WHERE m.account = g.account AND m.group_id = g.group_id) AS message_count
    FROM wechat_groups g ORDER BY g.name, g.account`;
  const selected = groups.find((g) => g.account === query.account && g.group_id === query.group) ?? (query.group ? null : groups[0]);
  if (!selected) return { ready: true, groups, messages: [], hasMore: false };
  const page = Math.max(1, Math.min(10000, Number(query.page) || 1));
  const messages = await sql<WechatInbox["messages"]>`SELECT message_id, group_id, sender_id, sender_name, content, sent_at::float8 AS sent_at, revoked FROM wechat_messages
    WHERE account = ${selected.account} AND group_id = ${selected.group_id}
    ORDER BY sent_at DESC, message_id DESC LIMIT 101 OFFSET ${(Math.floor(page) - 1) * 100}`;
  return { ready: true, groups, messages: messages.slice(0, 100), hasMore: messages.length > 100 };
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
