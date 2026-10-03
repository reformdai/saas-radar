// The Mac bridge talks only to an explicit loopback WeFlow endpoint. SSE is a hint;
// a complete, fixed query window advances the durable checkpoint, never SSE itself.
import type { WechatEvent, WechatGroup, WechatIntake } from "@aihot/contracts/wechat";

type Json = Record<string, unknown>;
const object = (v: unknown): Json => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const text = (v: unknown) => typeof v === "string" ? v : "";
const id = (v: unknown) => typeof v === "string" && /^[1-9]\d{0,24}$/.test(v) ? v : "";
const timestamp = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;

export function weflowBase(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== "/") {
    throw new Error("WeFlow 地址必须是本机 HTTP 地址，例如 http://127.0.0.1:5031");
  }
  return u.origin;
}

export function pushEvent(eventName: string, value: unknown, groups: ReadonlySet<string>): WechatEvent | null {
  if (eventName !== "message.new" && eventName !== "message.revoke") return null;
  const p = object(value);
  const group = text(p.sessionId);
  if (!group.endsWith("@chatroom") || !groups.has(group)) return null;
  const messageId = id(p.rawid);
  const ts = timestamp(p.timestamp);
  if (!messageId || !ts) return null; // Never coerce already-rounded numeric IDs.
  return {
    group_id: group, group_name: text(p.groupName), message_id: messageId,
    sender_id: "", sender_name: text(p.sourceName),
    content: eventName === "message.revoke" ? "" : text(p.content),
    sent_at: ts, revoked: eventName === "message.revoke",
  };
}

export function pulledEvent(group: string, name: string, value: unknown): WechatEvent | null {
  const p = object(value);
  const messageId = id(p.serverId);
  const ts = timestamp(p.createTime);
  if (!messageId || !ts) return null;
  return {
    group_id: group, group_name: name, message_id: messageId,
    sender_id: text(p.senderUsername), sender_name: text(p.senderName),
    content: text(p.parsedContent) || text(p.content), sent_at: ts, revoked: false,
  };
}

/** Streaming UTF-8/CRLF and multiple data lines, including an unfinished final event. */
export async function* sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "", event = "message", data: string[] = [];
  const line = (value: string) => {
    if (!value) {
      const result = data.length ? { event, data: data.join("\n") } : null;
      event = "message"; data = [];
      return result;
    }
    if (value.startsWith("event:")) event = value.slice(6).trim();
    if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
    return null;
  };
  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      if (buffer.length + data.reduce((n, s) => n + s.length, 0) > 1024 * 1024) throw new Error("WeFlow SSE 事件过大");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const next = line(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
        if (next) yield next;
      }
      if (result.done) break;
    }
    // SSE dispatch requires a blank line. A truncated event is recovered by polling.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface BridgeOptions {
  baseUrl: string;
  token: string;
  account: string;
  groups: string[];
  initialSince: number;
  sink: { send(body: WechatIntake): Promise<void>; status(account: string): Promise<WechatGroup[]> };
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
  pollMs?: number;
}

export class WeFlowBridge {
  private readonly options: BridgeOptions;
  private readonly base: string;
  private readonly selected: Set<string>;
  constructor(options: BridgeOptions) {
    this.base = weflowBase(options.baseUrl);
    if (!options.token || /[\r\n]/.test(options.token)) throw new Error("请配置有效的 WEFLOW_TOKEN");
    if (!options.groups.length || options.groups.length > 100 || options.groups.some((g) => !/^[\w-]+@chatroom$/.test(g) || g.length > 120)) throw new Error("指定 1–100 个有效的群 ID");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(options.account)) throw new Error("账号标记只能包含字母、数字、下划线和短横线");
    if (!Number.isSafeInteger(options.initialSince) || options.initialSince <= 0) throw new Error("初始同步时间无效");
    this.options = options;
    this.selected = new Set(options.groups);
  }
  private now() { return Math.floor((this.options.now?.() ?? Date.now()) / 1000); }
  private async request(endpoint: string, signal: AbortSignal, streaming = false) {
    const response = await (this.options.fetch ?? fetch)(`${this.base}${endpoint}`, {
      headers: { authorization: `Bearer ${this.options.token}`, accept: streaming ? "text/event-stream" : "application/json" },
      redirect: "error", signal: streaming ? signal : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error(`WeFlow 请求失败（HTTP ${response.status}）`);
    return response;
  }
  async register(signal: AbortSignal) {
    const response = await this.request("/api/v1/sessions?limit=10000", signal);
    const body = object(await response.json());
    if (body.success !== true || !Array.isArray(body.sessions)) throw new Error("WeFlow 会话列表格式无效");
    const names = new Map(body.sessions.map((p: unknown) => { const s = object(p); return [text(s.username), text(s.displayName)] as const; }));
    if ([...this.selected].some((g) => !names.has(g))) throw new Error("指定群未出现在 WeFlow 会话列表，请检查群 ID 和连接账号");
    await this.options.sink.send({ account: this.options.account, initialSince: this.options.initialSince, groups: [...this.selected].map((g) => ({ id: g, name: names.get(g) || g })) });
  }
  async reconcile(signal: AbortSignal) {
    const groups = await this.options.sink.status(this.options.account);
    for (const group of groups.filter((g) => g.enabled && this.selected.has(g.group_id))) {
      const through = this.now();
      const start = Math.max(0, group.reconcile_through - 60); // same-second/late arrivals
      let offset = 0;
      while (true) {
        signal.throwIfAborted();
        const params = new URLSearchParams({ talker: group.group_id, start: String(start), end: String(through), limit: "500", offset: String(offset) });
        const response = await this.request(`/api/v1/messages?${params}`, signal);
        const page = object(await response.json());
        if (page.success !== true || !Array.isArray(page.messages) || typeof page.hasMore !== "boolean") throw new Error("WeFlow 消息分页格式无效");
        const events: WechatEvent[] = [];
        for (const raw of page.messages) {
          const item = pulledEvent(group.group_id, group.name, raw);
          if (!item) continue; // unsupported/local-only messages have no stable server ID
          if (item.sent_at < start || item.sent_at > through) throw new Error("WeFlow 返回了时间窗口外的消息");
          events.push(item);
        }
        for (let i = 0; i < events.length; i += 50) await this.options.sink.send({ account: this.options.account, events: events.slice(i, i + 50) });
        if (!page.hasMore) break;
        if (!page.messages.length) throw new Error("WeFlow 分页未推进，保留原同步水位");
        offset += page.messages.length;
        if (offset > 100_000) throw new Error("补漏窗口超过十万条，请缩小历史范围");
      }
      await this.options.sink.send({ account: this.options.account, checkpoints: [{ groupId: group.group_id, through }] });
    }
  }
  async receive(signal: AbortSignal) {
    const response = await this.request("/api/v1/push/messages", signal, true);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("WeFlow 主动推送未启用或响应格式无效");
    this.options.log?.("WeFlow SSE 已连接");
    for await (const item of sseEvents(response.body)) {
      if (item.event !== "message.new" && item.event !== "message.revoke") continue;
      let value: unknown;
      try { value = JSON.parse(item.data); } catch { throw new Error("WeFlow SSE 返回了无效 JSON"); }
      const event = pushEvent(item.event, value, this.selected);
      if (event) await this.options.sink.send({ account: this.options.account, events: [event] });
      else if (this.selected.has(text(object(value).sessionId))) this.options.log?.("已选择群有一条事件缺少有效消息 ID 或时间，未上报；等待查询补漏。");
    }
    if (!signal.aborted) throw new Error("WeFlow SSE 连接已断开");
  }
  async run(signal: AbortSignal) {
    await this.register(signal);
    const delay = async (ms: number) => {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, ms);
        signal.addEventListener("abort", finish, { once: true });
      });
    };
    const poll = async () => {
      while (!signal.aborted) {
        try { await this.reconcile(signal); }
        catch { if (!signal.aborted) this.options.log?.("补漏失败，水位保留；下一轮重试。请检查 WeFlow 与接收服务。"); }
        await delay(this.options.pollMs ?? 60_000);
      }
    };
    const push = async () => {
      while (!signal.aborted) {
        try { await this.receive(signal); }
        catch { if (!signal.aborted) this.options.log?.("SSE 断开或上报失败，5 秒后重连；定期查询负责补漏。"); }
        await delay(5000);
      }
    };
    await Promise.all([poll(), push()]);
  }
}
