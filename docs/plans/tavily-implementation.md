# Tavily 主动搜索实施

2026-10-03：Claude Code 开发，Codex 验收。上级计划 `active-discovery.md`。不迁移、不提交推送部署、不读改真实 `.env`/密钥/认证；不开真实采集、模型或付费请求；不构建到 `apps/web/build`；保留既有未提交改动和 `.worktreeinclude`。

## 目标

每天北京时间 06:30 跑一次：最多 20 次 Tavily Search（16 basic + 4 advanced），自然月 ≤ 900 credits。只在 `TAVILY_SEARCH_ENABLED=true` 且有 `TAVILY_API_KEY` 时运行。结果走现有材料入口 → 正文抓取 → 分析 → publication，今日发现卡片带检索证据。

## 依据（官方文档，2026-10-03 核对）

`POST https://api.tavily.com/search`，`Authorization: Bearer`。固定参数：`search_depth`、`max_results=5`、`auto_parameters=false`、`include_answer=false`、`include_raw_content=false`、`include_usage=true`。basic 1 credit、advanced 2 credits，`usage.credits` 为实扣。`results[].content` 只当摘要，`score` 不用。

## 已核对的源码复用点

- `providers/receipts.ts`：工作区已有 `ReceiptRequest.guard(tx)`（在 advisory lock 内、`checkBudget` 后、写 attempt 前执行），本次直接用，不再改。`budgets` 无 `tavily` 行时 `checkBudget` 不限，硬限制全由 guard 负责，不插入 budgets 行。
- `providers/jina.ts`：Tavily 照抄其写法（`credential("collectors", …)`、`guardedFetch`、`ProviderRejectedError` 区分 4xx/429/5xx、`paidRequest` 包裹）。
- `content/materials.ts` `upsertMaterial`：URL 身份去重、显式 `backfill` 原因、`isHistorical` 不建事件不加热度；已存在 URL 只记 discovery。
- `jobs/content.ts` `queueProcessing`：`editorial` 信源进分析；`bodyStatus='pending'` 由路由先抓正文。
- `ingest/items.ts`：`INSERT INTO sources … 'external' … ON CONFLICT` 的建信源写法。
- `providers/llm.ts` `chatJson` + `editorial/models.ts` `CAPABILITIES`：AI 查询走现有模型回执；`MODEL_CALLS_ENABLED=false` 时抛错 → 回退。
- `apps/worker/src/schedules.ts` + `jobs/queue.ts` `recordRun`：run 返回对象即写入 `job_runs.detail`。
- `publication/discoveries.ts` `arrivalOf` / `ARRIVAL_LABELS`：扩展一个到达方式即可，不新增出口。

## 文件与步骤

1. **新增 `packages/backend/src/providers/tavily.ts`**：`tavilySearch(query, { depth, day, lane })`。
   - `paidRequest({ service: "tavily", purpose: "active_search", identity: { day, query, depth, params }, requestSummary: { query, searchDepth: depth, lane }, guard })`，同日同查询复用回执，不重复付费。
   - guard：按 `receipt_attempts.receipt_id` 关联 `receipts.request->>'searchDepth'`，统计 `service='tavily' AND origin='live'` 全部状态的尝试：北京自然日 basic < 16、advanced < 4；北京自然月 `sum(greatest(深度估算, usage->>'credits'))` + 本次估算 ≤ 900；超限抛 `BudgetExceededError`。
   - cost 写 `{ amount: credits, currency: "credit", basis: "actual" }`（无 usage 时按深度估算，basis `estimated`）。
2. **新增 `industry/search.ts`**：四条线 `reddit 6 / founder-blog 6 / niche-need 4 / new-product 4`，每线 1 次 advanced；每线一半固定模板（按日期轮换）、一半 AI 生成。模板文案先写草稿，**上线前请主人确认**。
3. **新增 `industry/prompts/search-queries.md`** 和 `editorial/models.ts` 能力 `search`（`SEARCH_MODEL`，purpose `search_queries`）。输入只用 `industry/topics.json` 公开主题和近日公开标题；identity 含北京日期，同日重跑复用同一批查询。失败/关闭/数量不足 → 固定模板补齐。
4. **新增 `packages/backend/src/sources/search.ts`**：`runActiveSearch()`。
   - 开关或 Key 缺失 → 返回 `{ skipped: reason }`。
   - 建信源 `tavily-search`（`external`、`T2`、`editorial`、`config='{}'`，`ON CONFLICT DO NOTHING`），开 `fetch_runs` 记录。
   - 先恢复：`receipts WHERE service='tavily' AND status='received'` 重新导入后 `completeReceipt`。
   - 串行执行计划；429/5xx/连接失败同轮重试一次（同样计额度）；`BudgetExceededError` 停止本轮；`ReceiptUnknownError`/`ReceiptBusyError` 跳过。
   - 每条结果在一个事务里：`upsertMaterial({ via: "fetch", excerpt: content, bodyStatus: "pending", publishedAt: published_date, backfill: "active-search", raw: { search: { provider: "tavily", query, lane, depth } } })` + `queueProcessing(id, { db: tx })`，再 `completeReceipt`。
   - 返回 `{ planned, searched, reused, failed, imported, dayUsed, monthCredits }` 写入 job_runs；更新 fetch_runs 与信源健康。
5. **改 `apps/worker/src/schedules.ts`**：`collecting && TAVILY_SEARCH_ENABLED==="true" && credential(...)` 时注册 `{ name: "search.active", cron: "30 6 * * *", missed: "once" }`。
6. **前台证据**：
   - `packages/contracts/src/site.ts`：`DiscoveryArrival` 加 `"search"`，`ARRIVAL_LABELS.search = { label: "主动搜索", hint: … }`；`DiscoveryItem` 加 `search: { provider: string; query: string } | null`。
   - `publication/discoveries.ts`：`arrivalOf` 识别 `active-search`；SELECT 加 `a.raw->'search'`，截断 query 长度。
   - `apps/web/app/features/feed/DiscoveryItem.tsx`：显示“主动搜索 · Tavily · 查询：…”。
7. **文档与样例**：`.env.example` 加 `TAVILY_SEARCH_ENABLED=false`、`TAVILY_API_KEY=`；README 写启用、额度、检查方法（job_runs、信源页、回执）。

## 测试（无外网，用 `tests/setup.ts` stub）

- 新增 `tests/active-search.test.ts`：Bearer 与固定参数；basic/advanced 日配额 16/4；预置尝试触发月 900；失败尝试占额度；同日重跑不发请求；`received` 回执恢复导入；URL 去重与 `raw.search`；开关关/无 Key 跳过；模型关闭回退模板。
- 改 `tests/saas-radar.test.ts`（arrival 键加 `search`）、`tests/discoveries.test.ts`（search 证据字段）。
- 验收命令：`npm run typecheck`；`DATABASE_URL=postgres://127.0.0.1:5432/saas_radar_test npm test`（既有测试库，不跑迁移）；web 构建在临时目录 + `node --test apps/web/tests/*.test.ts`。

## 不做

迁移、budgets 行写入、Tavily Extract、Exa、auto_parameters、自动付费升级。

## 进度

- [x] 读 AGENTS、active-discovery 与相关源码，确定文件与步骤。
- [x] 按主人批准的四条线与每日20次预算实施固定查询模板；模板逐条文案未经主人单独评审。
- [x] 实施（provider、查询计划、主动搜索任务、worker 调度、搜索证据展示、样例配置和 mock 测试）。
- [x] Codex 验收：typecheck 通过；主动搜索、发现页、信源、架构相关测试 27 项通过；没有真实 Tavily 请求。

## 记录

- 实际启用仍需主人在自己的 `.env` 中配置 `TAVILY_SEARCH_ENABLED=true` 和 `TAVILY_API_KEY`，并重启 worker；本轮没有修改真实 `.env`。
- Tavily RSS/网页访问仍受目标站点自身限制；搜索结果只作为线索，正文获取失败会保留相应材料状态。
- 前端生产构建未在本轮运行，避免覆盖当前运行中的 `apps/web/build`；typecheck 已覆盖前端类型。
- 下一步：先核对WORKLOG.md最新交接，验证前端构建/测试并安排重启，随后主人配置Key和开关后再真实试跑、使用教学；当前测试通过不代表真实API或前端交互已验收。
