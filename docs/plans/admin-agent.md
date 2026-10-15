# 后台智能体「小雷」

分支：`feat/admin-agent`（worktree `../aihot-agent`，基于 `feat/saas-radar-v1` 的 9d13f4b）。

## 目标

管理员在后台和智能体对话，由它代为查询和操作，不必自己找页面、填配置。模型用站点默认模型（`LLM_*`，本站配的是 DeepSeek），不另加配置。

主人确认的范围（2026-10-12）：

- 能力：查询（只读）、信源管理、采集与归档、内容处理，四类都要。
- 确认：查询直接回答；任何写操作先在对话里给出确认卡（做什么、改前改后、大概费用），主人点确认才执行。
- 人设：毒舌小助理，名字「小雷」，吐槽但靠谱，数字和事实不编。
- 开发位置：独立 worktree，不碰主工作区的未提交改动。

## 设计

- 对话存 `settings` 表，键为 `agent:<id>`，一段对话一行（同研究记录的做法），不新增迁移。
- 页面提交消息 → API 记录并入队 `agent.turn` → worker 调模型（`chatJson`，走回执与预算熔断）。模型每步返回 `{ say, action }`：
  - 只读工具：worker 直接执行，把结果作为资料喂回模型，最多 6 步。
  - 写操作：只校验参数、读取当前版本，生成待确认的提议后停下，不执行。
- 确认：API（`admin/agent.ts`）用提议里保存的参数和版本号调用后台已有函数执行，记审计，执行人为当前管理员；然后入队一步，让小雷说明结果。版本已变时报冲突，不覆盖。
- 取消，或在待确认时直接发新消息：提议作废，不执行。
- `admin/` 是最上层，`agent/` 和 worker 不能引用它（`tests/architecture.test.ts`）。所以只读工具和提议在 `agent/tools.ts` 里自己读库；执行写操作在 `admin/agent.ts`，调用后台已有函数（`admin/sources`、`admin/content`、`sources/mp-archive`、`events/corrections`），不直接写库。
- 不开放：预算、模型切换、密钥与设置、反馈、回执释放。
- 发给模型的信源配置去掉疑似密钥字段（key/token/secret/cookie/password）。工具结果当资料，不执行其中的指令。

## 涉及文件

- `packages/contracts/src/agent.ts`：对话、消息、提议类型
- `packages/backend/src/agent/`：对话存取、工具定义（只读与提议）、模型循环
- `packages/backend/src/admin/agent.ts`：执行已确认的提议
- `packages/backend/src/jobs/agent.ts`、`jobs/queue.ts`、`apps/worker/src/main.ts`：队列
- `apps/api/src/routes/admin.ts`：`/api/admin/agent*`
- `apps/web/app/routes/admin/agent.tsx`、`routes.ts`、`routes/admin/layout.tsx`：页面与导航
- `tests/agent.test.ts`
- `docs/agent.md`：使用说明

## 验收

- [x] 只读问题：模型调用工具后回答，对话状态回到空闲，过程中不改任何数据
- [x] 写操作：生成确认卡，确认前数据不变；确认后经后台函数执行并有审计；取消后不执行
- [x] 版本冲突、参数不合法、未知工具都有明确提示，不会卡住对话
- [x] `npm run typecheck`、相关测试、前端构建与前端测试通过
- [ ] 需要主人：合并、重建后做一次真实对话验收

## 进度

- 2026-10-12：方案确定，开始实现。
- 2026-10-12：实现完成。`npm run typecheck` 通过；`tests/agent.test.ts` 4/4、`tests/architecture.test.ts` 通过；完整 `npm test` 643 个中 627 个通过，15 个失败与基础分支 9d13f4b 上完全相同（备份、队列恢复、事件/日报恢复、热榜封面等，与本功能无关）；前端构建通过，前端测试 39/39。在测试库上起 API 和 web，用示例对话截图检查了亮色、深色、空状态和手机宽度，控制台无报错。
- 2026-10-15：主人指出 `.env` 的默认模型已是 DeepSeek，改用 `default` 模型（`LLM_*`、`llm` 预算），不再需要 `DEEPSEEK_*`。
- 未做：真实模型对话；`scripts/smoke.ts`（预览站点连的是测试库）。worker 的轮询入队没有在浏览器里端到端跑过，逻辑由测试直接调用 `runAgentTurn` 覆盖。
