// Run on the Mac hosting WeFlow; secrets are supplied by the operator, never logged or saved.
import { parseArgs } from "node:util";
import { WeFlowBridge, weflowBase } from "../packages/backend/src/wechat/bridge.ts";
import type { WechatGroup, WechatIntake } from "@aihot/contracts/wechat";

const { values } = parseArgs({ options: {
  group: { type: "string", multiple: true }, account: { type: "string", default: "main" },
  since: { type: "string" }, "list-groups": { type: "boolean" }, help: { type: "boolean" },
} });

if (values.help) {
  console.log("使用：node scripts/weflow-bridge.ts --list-groups\n或：node scripts/weflow-bridge.ts --group 123@chatroom [--group 456@chatroom] [--account main] [--since 2026-10-03T08:00:00+08:00]\n需要 WEFLOW_TOKEN；采集时还需 AIHOT_BRIDGE_URL 和 INGEST_TOKEN。详见 docs/weflow.md。");
} else {
  const base = weflowBase(process.env.WEFLOW_BASE_URL || "http://127.0.0.1:5031");
  const token = process.env.WEFLOW_TOKEN || "";
  if (!token || /[\r\n]/.test(token)) throw new Error("请在本地进程环境中配置 WEFLOW_TOKEN");
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  if (values["list-groups"]) {
    const response = await fetch(`${base}/api/v1/sessions?limit=10000`, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`WeFlow 会话查询失败（HTTP ${response.status}）`);
    const body = await response.json() as { success: boolean; sessions: Array<{ username: string; displayName: string }> };
    if (!body.success || !Array.isArray(body.sessions)) throw new Error("WeFlow 会话列表无效");
    for (const g of body.sessions.filter((s) => s.username?.endsWith("@chatroom"))) console.log(`${g.username}\t${g.displayName}`);
  } else {
    const destination = new URL(process.env.AIHOT_BRIDGE_URL || "http://127.0.0.1:3001");
    if (destination.username || destination.password || destination.search || destination.hash || destination.pathname !== "/" || !(destination.protocol === "https:" || destination.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(destination.hostname))) {
      throw new Error("接收服务必须使用 HTTPS，或本机 HTTP 地址");
    }
    const ingestToken = process.env.INGEST_TOKEN || "";
    if (ingestToken.length < 16 || /[\r\n]/.test(ingestToken)) throw new Error("请配置与 aihot 一致的 INGEST_TOKEN（至少 16 位）");
    const since = values.since ? Date.parse(values.since) : Date.now();
    if (!Number.isFinite(since) || since <= 0 || since > Date.now()) throw new Error("--since 应为不晚于现在的 ISO 日期时间");
    const request = async (path: string, body?: WechatIntake) => {
      const response = await fetch(`${destination.origin}${path}`, {
        method: body ? "POST" : "GET", redirect: "error",
        headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      });
      if (!response.ok) throw new Error(`群聊接收服务请求失败（HTTP ${response.status}）`);
      return response.json();
    };
    const bridge = new WeFlowBridge({ baseUrl: base, token, account: values.account!, groups: values.group ?? [], initialSince: Math.floor(since / 1000), log: console.log,
      sink: {
        send: async (body) => { await request("/api/ingest/wechat", body); },
        status: async (account) => (await request(`/api/ingest/wechat/status?account=${encodeURIComponent(account)}`) as { groups: WechatGroup[] }).groups,
      },
    });
    try { await bridge.run(controller.signal); }
    catch { if (!controller.signal.aborted) { console.error("采集桥启动失败。请检查群 ID、WeFlow API/主动推送、Token 和接收服务；未输出凭据或消息。"); process.exitCode = 1; } }
  }
}
