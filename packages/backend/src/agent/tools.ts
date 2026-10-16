// The admin agent's tools, as the worker uses them. Read tools run on their own; write tools only
// describe a proposal. The confirmed proposal runs in admin/agent.ts, through the back office's own
// functions (admin/ is the top layer, so nothing here imports it).
import { z } from "zod";
import type { AgentProposal } from "@aihot/contracts/agent";
import { sql } from "../db.ts";
import { archiveState } from "../sources/mp-archive.ts";
import { assertSupportedConfig } from "../sources/config-keys.ts";
import type { SourceRow } from "../sources/types.ts";
import { searchKnowledge, type KnowledgeHit } from "../knowledge/search.ts";

/** Same estimates as the archive card: one list request, in CNY. */
const LIST_PRICE = { dajiala: 0.14, everyinfra: 0.04 } as const;
const KINDS = ["rss", "web_list", "json_list", "x_search", "mp_account", "external"] as const;
const SECRET = /key|token|secret|cookie|passw/i;

/** Source config as the model may see it: anything that looks like a credential is left out. */
function redact(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).map(([k, v]) => [k, SECRET.test(k) ? "[已隐藏]" : v]));
}
const clip = (value: unknown, max: number) => {
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
};
const show = (value: unknown) => value === undefined ? "（无）" : JSON.stringify(value);
const listProviderOf = (config: Record<string, unknown>) => (config.listProvider === "everyinfra" ? "everyinfra" : "dajiala");

export class ToolInputError extends Error {}

type Proposal = Omit<AgentProposal, "id" | "tool">;
/** `materials` are knowledge passages the answer may cite; the turn numbers them [1], [2]… in the order found. */
interface ReadTool<A> { kind: "read"; description: string; params: string; args: z.ZodType<A>; run(args: A): Promise<{ result: unknown; summary: string; materials?: KnowledgeHit[] }> }
interface WriteTool<A> { kind: "write"; description: string; params: string; args: z.ZodType<A>; propose(args: A): Promise<Proposal> }
type Tool = ReadTool<any> | WriteTool<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
// Typed one by one, so each tool's arguments are checked against its own schema.
const read = <A>(t: Omit<ReadTool<A>, "kind">): ReadTool<A> => ({ kind: "read", ...t });
const write = <A>(t: Omit<WriteTool<A>, "kind">): WriteTool<A> => ({ kind: "write", ...t });

type Source = SourceRow & { name: string; enabled: boolean; health: string; updated_at: Date; config: Record<string, unknown> } & Record<string, unknown>;
async function sourceOrThrow(id: string): Promise<Source> {
  const [s] = await sql<Source[]>`SELECT * FROM sources WHERE id = ${id}`;
  if (!s) throw new ToolInputError(`没有 ID 为 ${id} 的信源`);
  return s;
}
async function articleOrThrow(id: string) {
  const [a] = await sql<{ id: string; title: string; processing_state: string; title_zh: string | null; visibility: string | null; version: number | null }[]>`
    SELECT a.id, a.title, a.processing_state, p.title AS title_zh, o.visibility, o.version
    FROM articles a LEFT JOIN publications p ON p.article_id = a.id LEFT JOIN editorial_overrides o ON o.article_id = a.id WHERE a.id = ${id}`;
  if (!a) throw new ToolInputError(`没有 ID 为 ${id} 的内容`);
  return a;
}

export const TOOLS: Record<string, Tool> = {
  search_knowledge: read({
    description: "在资料库里检索：全部信源的文章正文（公众号、博客、HN、主动搜索等）、微信群摘要和群聊原消息。回答观点、方法、事实类问题前先用它；返回带编号的片段。"
      + "source 填信源或群名（如“刘小排”）只搜它；articleId 只搜一篇（用户正在看的文章）；kind 限定 article 或 wechat；since 为 YYYY-MM-DD",
    params: "{ q: string, source?: string, articleId?: string, kind?: all|article|wechat, since?: string }",
    args: z.object({ q: z.string().trim().min(1).max(200), source: z.string().trim().max(80).optional(), articleId: z.string().max(100).optional(),
      kind: z.enum(["all", "article", "wechat"]).optional(), since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    async run(a) {
      const materials = await searchKnowledge(a);
      return { result: materials.length ? "见 materials" : "没有找到相关资料", materials,
        summary: `翻了资料库「${a.q}」${a.source ? `（${a.source}）` : ""}，找到 ${materials.length} 段` };
    },
  }),
  list_sources: read({
    description: "列出信源，可按关键词、类型、健康状态筛选", params: `{ q?: string, kind?: ${KINDS.join("|")}, health?: string, enabled?: boolean }`,
    args: z.object({ q: z.string().optional(), kind: z.enum(KINDS).optional(), health: z.string().optional(), enabled: z.boolean().optional() }),
    async run(a) {
      const q = a.q?.trim() ? `%${a.q.trim()}%` : null;
      const rows = await sql`
        SELECT s.id, s.name, s.kind, s.enabled, s.health, s.last_ok_at, left(s.last_error, 120) AS last_error,
               (SELECT count(*)::int FROM articles x WHERE x.source_id = s.id AND x.discovered_at > now() - interval '7 days') AS items_7d
        FROM sources s
        WHERE (${q}::text IS NULL OR s.name ILIKE ${q} OR s.id ILIKE ${q})
          AND (${a.kind ?? null}::text IS NULL OR s.kind = ${a.kind ?? null})
          AND (${a.health ?? null}::text IS NULL OR s.health = ${a.health ?? null})
          AND (${a.enabled ?? null}::boolean IS NULL OR s.enabled = ${a.enabled ?? null})
        ORDER BY s.enabled DESC, CASE s.health WHEN 'failing' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END, s.name LIMIT 40`;
      return { result: rows, summary: `翻了翻信源列表（${rows.length} 个）` };
    },
  }),
  source_detail: read({
    description: "查看一个信源的配置、统计、最近采集记录和最近文章；公众号还附带历史归档进度", params: "{ id: string }",
    args: z.object({ id: z.string().min(1) }),
    async run(a) {
      const s = await sourceOrThrow(a.id);
      const [stats] = await sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE discovered_at > now() - interval '7 days')::int AS last7d FROM articles WHERE source_id = ${a.id}`;
      const runs = await sql`SELECT started_at, status, found_count AS found, new_count AS new, left(error, 200) AS error FROM fetch_runs WHERE source_id = ${a.id} ORDER BY started_at DESC LIMIT 5`;
      const items = await sql`
        SELECT a.id, coalesce(p.title, a.title) AS title, a.discovered_at, a.processing_state FROM articles a LEFT JOIN publications p ON p.article_id = a.id
        WHERE a.source_id = ${a.id} ORDER BY a.discovered_at DESC LIMIT 5`;
      const result = {
        source: { id: s.id, name: s.name, kind: s.kind, tier: s.tier, participation_mode: s.participation_mode, enabled: s.enabled, health: s.health,
          interval_minutes: s.interval_minutes, last_ok_at: s.last_ok_at, last_error: s.last_error, config: redact(s.config) },
        stats, runs, items, archive: s.kind === "mp_account" ? await archiveState(a.id) : undefined,
      };
      return { result, summary: `看了信源「${s.name}」的详情` };
    },
  }),
  archive_status: read({
    description: "查看公众号历史文章归档的进度", params: "{ sourceId: string }",
    args: z.object({ sourceId: z.string().min(1) }),
    async run(a) { return { result: (await archiveState(a.sourceId)) ?? "还没有归档记录", summary: `查了 ${a.sourceId} 的归档进度` }; },
  }),
  search_content: read({
    description: "按标题关键词或文章 ID 搜索内容", params: "{ q: string }",
    args: z.object({ q: z.string().min(1) }),
    async run(a) {
      const like = `%${a.q.trim()}%`;
      const rows = await sql`
        SELECT a.id, coalesce(p.title, a.title) AS title, s.name AS source, a.discovered_at, a.processing_state, p.visibility, p.selected, p.score
        FROM articles a JOIN sources s ON s.id = a.source_id LEFT JOIN publications p ON p.article_id = a.id
        WHERE a.id = ${a.q.trim()} OR a.title ILIKE ${like} OR p.title ILIKE ${like} ORDER BY a.discovered_at DESC LIMIT 15`;
      return { result: rows, summary: `搜了「${a.q}」（${rows.length} 条）` };
    },
  }),
  content_detail: read({
    description: "查看一条内容：原文信息、处理状态、发布状态、人工更正和最新一次分析", params: "{ id: string }",
    args: z.object({ id: z.string().min(1) }),
    async run(a) {
      const [article] = await sql`
        SELECT id, source_id, url, title, published_at, discovered_at, body_status, processing_state, processing_error, length(body_text) AS body_chars
        FROM articles WHERE id = ${a.id}`;
      if (!article) throw new ToolInputError(`没有 ID 为 ${a.id} 的内容`);
      const [publication] = await sql`SELECT * FROM publications WHERE article_id = ${a.id}`;
      const [override] = await sql`SELECT fields, visibility, reason, version, updated_at FROM editorial_overrides WHERE article_id = ${a.id}`;
      const [analysis] = await sql`SELECT model, relevance, category, score, selected, title_zh, reason_zh, created_at FROM analyses WHERE article_id = ${a.id} ORDER BY id DESC LIMIT 1`;
      return { result: clip({ article, publication: publication ?? null, override: override ?? null, analysis: analysis ?? null }, 5000), summary: `看了内容「${String(article.title).slice(0, 30)}」` };
    },
  }),
  runs_overview: read({
    description: "查看运行状况：排队中的任务、最近 24 小时失败的任务、落后或失败的信源、有问题的付费回执", params: "{}",
    args: z.object({}),
    async run() {
      const [queues, failedJobs, lagging, receipts, failedArticles] = await Promise.all([
        sql`SELECT name, state, count(*)::int AS n, min(created_on) AS oldest FROM pgboss.job WHERE state IN ('created', 'retry', 'active') GROUP BY 1, 2 ORDER BY 1, 2`,
        sql`SELECT name, count(*)::int AS failed, max(completed_on) AS last FROM pgboss.job WHERE state = 'failed' AND completed_on > now() - interval '24 hours' GROUP BY 1 ORDER BY 2 DESC`,
        sql`SELECT id, name, kind, health, fail_count, last_ok_at, left(last_error, 160) AS last_error FROM sources
            WHERE enabled AND (health IN ('failing', 'degraded') OR next_fetch_at < now() - interval '30 minutes') ORDER BY health = 'failing' DESC, next_fetch_at LIMIT 15`,
        sql`SELECT id, service, purpose, subject, status, left(error, 160) AS error, updated_at FROM receipts
            WHERE status = 'unknown' OR (status = 'failed' AND updated_at > now() - interval '3 days') OR (status = 'pending' AND updated_at < now() - interval '15 minutes')
            ORDER BY updated_at DESC LIMIT 15`,
        sql`SELECT count(*)::int AS n FROM articles WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days'`,
      ]);
      return { result: clip({ queues, failedJobs, lagging, receipts, failedArticles30d: failedArticles[0]?.n ?? 0 }, 6000), summary: "看了一眼运行状况" };
    },
  }),
  spend_summary: read({
    description: "按服务汇总最近几天的付费请求次数和费用（按服务原币种）", params: "{ days?: number (1-30, 默认 7) }",
    args: z.object({ days: z.number().int().min(1).max(30).default(7) }),
    async run(a) {
      const rows = await sql`
        SELECT service, coalesce(currency, '-') AS currency, count(*)::int AS requests,
               count(*) FILTER (WHERE status = 'failed')::int AS failed, round(coalesce(sum(cost), 0)::numeric, 4)::float AS cost
        FROM receipts WHERE created_at > now() - make_interval(days => ${a.days}) GROUP BY 1, 2 ORDER BY 1, 2`;
      return { result: { days: a.days, rows }, summary: `算了算最近 ${a.days} 天的花销` };
    },
  }),

  create_source: write({
    description: "新建信源（新建后按周期自动采集）",
    params: `{ id: string (小写字母数字和连字符), name: string, kind: ${KINDS.join("|")}, config: object, tier?: T1|T1_5|T2|EXCLUDE_MP, participation_mode?: editorial|hot_signal|isolated, interval_minutes?: number }`,
    args: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/), name: z.string().min(1).max(200), kind: z.enum(KINDS), config: z.record(z.string(), z.unknown()),
      tier: z.enum(["T1", "T1_5", "T2", "EXCLUDE_MP"]).optional(), participation_mode: z.enum(["editorial", "hot_signal", "isolated"]).optional(),
      interval_minutes: z.number().int().min(1).max(1440).optional() }),
    async propose(a) {
      assertSupportedConfig(a.kind, a.config);
      const [taken] = await sql`SELECT 1 FROM sources WHERE id = ${a.id}`;
      if (taken) throw new ToolInputError(`信源 ID ${a.id} 已存在`);
      const paid = a.kind === "mp_account" || a.kind === "x_search";
      return { title: `新建信源「${a.name}」`, args: a, costCny: null, costNote: paid ? "新建后会按周期自动采集，这类信源每次采集都要付费" : null,
        lines: [`ID：${a.id}`, `类型：${a.kind}`, `配置：${JSON.stringify(redact(a.config))}`, ...(a.tier ? [`级别：${a.tier}`] : []),
          ...(a.participation_mode ? [`参与方式：${a.participation_mode}`] : []), ...(a.interval_minutes ? [`采集间隔：${a.interval_minutes} 分钟`] : [])] };
    },
  }),
  update_source: write({
    description: "修改信源：名称、启停、采集间隔、级别、参与方式、标签，或合并修改配置（如把公众号列表服务商 listProvider 改为 dajiala）；config 中值为 null 的键会被删除",
    params: "{ id: string, patch: { name?: string, enabled?: boolean, interval_minutes?: number, tier?: string, participation_mode?: string, tags?: string[], config?: object }, reason?: string }",
    args: z.object({ id: z.string().min(1), reason: z.string().max(300).optional(), patch: z.object({
      name: z.string().min(1).max(200), enabled: z.boolean(), interval_minutes: z.number().int().min(1).max(1440),
      tier: z.enum(["T1", "T1_5", "T2", "EXCLUDE_MP"]), participation_mode: z.enum(["editorial", "hot_signal", "isolated"]),
      tags: z.array(z.string().max(60)).max(30), config: z.record(z.string(), z.unknown()),
    }).partial().strict() }),
    async propose(a) {
      const s = await sourceOrThrow(a.id);
      const patch: Record<string, unknown> = { ...a.patch };
      if (a.patch.config) {
        const merged: Record<string, unknown> = { ...s.config };
        for (const [k, v] of Object.entries(a.patch.config)) { if (v === null) delete merged[k]; else merged[k] = v; }
        assertSupportedConfig(s.kind, merged);
        patch.config = merged;
      }
      const changed = Object.keys(patch).filter((k) => JSON.stringify(s[k]) !== JSON.stringify(patch[k]));
      if (!changed.length) throw new ToolInputError("这些值和现在一样，没有要改的");
      const after = (patch.config ?? {}) as Record<string, unknown>;
      const lines = changed.flatMap((k) => k !== "config" ? [`${k}：${show(s[k])} → ${show(patch[k])}`]
        : Object.keys({ ...s.config, ...after }).filter((c) => JSON.stringify(s.config[c]) !== JSON.stringify(after[c]))
          .map((c) => SECRET.test(c) ? `config.${c}：[已隐藏] → [已隐藏]` : `config.${c}：${show(s.config[c])} → ${show(after[c])}`));
      return { title: `修改信源「${s.name}」`, lines, costCny: null, costNote: null,
        args: { id: a.id, patch: Object.fromEntries(changed.map((k) => [k, patch[k]])), reason: a.reason, version: new Date(s.updated_at).toISOString() } };
    },
  }),
  fetch_now: write({
    description: "立即采集一个信源", params: "{ id: string }",
    args: z.object({ id: z.string().min(1) }),
    async propose(a) {
      const s = await sourceOrThrow(a.id);
      const provider = listProviderOf(s.config);
      const cost = s.kind === "mp_account" ? LIST_PRICE[provider] : null;
      return { title: `立即采集「${s.name}」`, args: a, lines: [`类型：${s.kind}`, ...(s.kind === "mp_account" ? [`列表服务商：${provider}`] : [])],
        costCny: cost, costNote: cost ? "一次列表请求" : s.kind === "x_search" ? "会产生搜索接口费用" : null };
    },
  }),
  archive: write({
    description: "公众号历史文章归档：list 获取/继续历史列表（付费），bodies 补全缺失正文（免费），pause 暂停",
    params: "{ sourceId: string, action: list|bodies|pause, maxRequests?: number (1-20, 默认 5) }",
    args: z.object({ sourceId: z.string().min(1), action: z.enum(["list", "bodies", "pause"]), maxRequests: z.number().int().min(1).max(20).default(5) }),
    async propose(a) {
      const s = await sourceOrThrow(a.sourceId);
      if (s.kind !== "mp_account") throw new ToolInputError("只有公众号信源能做历史归档");
      const provider = listProviderOf(s.config);
      const state = await archiveState(a.sourceId);
      const label = { list: "获取历史列表", bodies: "补全缺失正文", pause: "暂停归档" }[a.action];
      const cost = a.action !== "list" ? null : provider === "everyinfra" ? LIST_PRICE.everyinfra : a.maxRequests * LIST_PRICE.dajiala;
      return { title: `${label} · ${s.name}`, args: a, costCny: cost,
        costNote: a.action === "list" ? (provider === "everyinfra" ? "万有引擎只发一次请求" : `最多 ${a.maxRequests} 页，到上限自动暂停`) : a.action === "bodies" ? "读文章页，不收费" : null,
        lines: [`列表服务商：${provider}`, ...(a.action !== "pause" ? [`本批最多请求：${a.maxRequests} 次`] : []),
          state ? `当前进度：列表 ${state.pages} 页 · 新入库 ${state.stored} 篇 · 已补全文 ${state.bodies} 篇${state.listComplete ? " · 列表已完成" : ""}` : "当前进度：还没归档过"] };
    },
  }),
  set_visibility: write({
    description: "设置内容在公开站点的可见性：public 公开，summary-only 只展示摘要，withdrawn 撤下", params: "{ id: string, visibility: public|summary-only|withdrawn, reason: string }",
    args: z.object({ id: z.string().min(1), visibility: z.enum(["public", "summary-only", "withdrawn"]), reason: z.string().trim().min(1).max(300) }),
    async propose(a) {
      const c = await articleOrThrow(a.id);
      const before = c.visibility ?? "public";
      if (before === a.visibility) throw new ToolInputError(`这条内容已经是 ${a.visibility}`);
      return { title: `修改可见性「${(c.title_zh ?? c.title).slice(0, 40)}」`, costCny: null, costNote: "会同步到网站、API、RSS 和 MCP",
        lines: [`可见性：${before} → ${a.visibility}`, `理由：${a.reason}`], args: { ...a, version: c.version ?? 0 } };
    },
  }),
  rerun: write({
    description: "重跑一条内容的某一步：extract 重新抓正文，analyze 重新分析（调用模型），group 重新归组", params: "{ id: string, step: extract|analyze|group }",
    args: z.object({ id: z.string().min(1), step: z.enum(["extract", "analyze", "group"]) }),
    async propose(a) {
      const c = await articleOrThrow(a.id);
      const label = { extract: "重新抓正文", analyze: "重新分析", group: "重新归组" }[a.step];
      return { title: `${label}「${(c.title_zh ?? c.title).slice(0, 40)}」`, args: a, lines: [`内容 ID：${a.id}`, `当前状态：${c.processing_state}`],
        costCny: null, costNote: a.step === "extract" ? null : "会调用模型，产生模型费用" };
    },
  }),
  merge_stories: write({
    description: "把一个事件合并进另一个事件（from 并入 into，旧链接继续可用）", params: "{ from: number, into: number, reason: string }",
    args: z.object({ from: z.number().int().positive(), into: z.number().int().positive(), reason: z.string().trim().min(1).max(300) }),
    async propose(a) {
      if (a.from === a.into) throw new ToolInputError("不能把事件合并进它自己");
      const rows = await sql<{ id: number; title: string; merged_into: number | null }[]>`SELECT id, title, merged_into FROM stories WHERE id IN (${a.from}, ${a.into})`;
      const from = rows.find((r) => r.id === a.from), into = rows.find((r) => r.id === a.into);
      if (!from || !into) throw new ToolInputError("找不到这两个事件");
      if (from.merged_into || into.merged_into) throw new ToolInputError("两个事件都必须是未合并的事件");
      return { title: "合并事件", args: a, costCny: null, costNote: null,
        lines: [`并入：#${from.id} ${from.title}`, `目标：#${into.id} ${into.title}`, `理由：${a.reason}`] };
    },
  }),
};

/** The tool list as the model reads it. */
export function toolCatalog(): string {
  return Object.entries(TOOLS).map(([name, t]) => `- ${name}（${t.kind === "read" ? "只读，直接执行" : "写操作，需要管理员确认"}）：${t.description}。参数 ${t.params}`).join("\n");
}
