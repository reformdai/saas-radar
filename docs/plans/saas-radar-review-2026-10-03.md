# 出海 SaaS 雷达第一版交叉评审

评审日期：2026-10-03。范围：`3343fe2..ff4aac2`，分支 `feat/saas-radar-v1`。初轮只读评审；随后用户明确要求 Claude Code 修复、Codex 验收，两项修复均已通过，改动未提交。原有 `.worktreeinclude` 保留。

## 修复与独立验收（已完成）

- 用户授权后，由本机 Claude Code 2.1.287 唯一写入产品代码，Codex 检查 diff 并独立复跑验证。
- RSS 短 content 在不满足全文条件且无 summary 时保留为 excerpt；已有 summary 优先，全文的 280 字符阈值不变。回归测试覆盖原文信息保留、材料状态、summary 优先和长帖行为，既有 teaser 测试也通过。
- discoveries 路由拒绝非整数 limit，返回 400；默认 20 和原有整数范围限制保留。读取层为非整数直接调用提供默认值保护。通过前端代理的真实 HTTP 实测：`1` → 200；`1.5`、`abc`、`Infinity` → 400。
- 改动限于 `packages/backend/src/sources/rss.ts`、`packages/backend/src/publication/discoveries.ts`、`apps/api/src/routes/site.ts`、`tests/saas-radar.test.ts`、`tests/discoveries.test.ts`，共 43 行新增、8 行删除。
- Codex 验收：类型检查、前端生产构建、后端/信源/架构相关测试 37 项、前端测试 31 项、站点 smoke 31 项全部通过，`git diff --check` 通过。
- 临时预览进程已停止。无提交、推送、迁移、部署或新增依赖；真实采集和业务模型调用始终关闭。
- 验收结论：本次两项缺陷关闭。真实选材质量校准、浏览器视觉和点击交互仍是独立待办，不能将本次验收理解为这些项目已完成。

## 结论

第一版约定的四类内容、今日发现、材料状态、推荐理由与待调查问题、品牌和模块开关已落地；复用 publication 读取层和发布闸门，未新增迁移或依赖。可以进入真实材料试运行，但不能据此认定选材质量已验收。以下保留初轮两项缺陷的证据，两项现已修复。

## 发现

### P2：新接入的 Reddit 搜索短帖未保留为摘要

- 相关改动：`industry/sources.json:49`、`tests/saas-radar.test.ts:86`；根因在沿用的 `packages/backend/src/sources/rss.ts:98`。
- Atom 帖子只有 `content`、没有 `summary`，且正文不超过 280 字符、不是 teaser 时，`feedText` 同时返回 `bodyText=null` 和 `excerpt=null`。
- 本地构造一条包含牙科诊所、保险报表导出痛点及每月 50 美元预算的短帖，复现结果为 `{body:null, excerpt:null, status:"pending", material:"title"}`。
- 原网页补抓成功时可恢复；补抓失败时已拿到的需求描述丢失，只剩标题，影响分析和材料状态。README 所称“很短的只算摘要”并不成立。
- 新测试只检查 short.bodyStatus，没有检查 excerpt，因此未捕获该问题。这是原解析器与新信源适配的问题。
- 建议：短 content 未作为正文时保留为 excerpt，并增加无 summary 短 Atom 帖的内容保留断言。

### P2：发现 API 未拒绝小数 limit，返回错误的服务不可用

- 位置：`apps/api/src/routes/site.ts:108`；下游 `publication/discoveries.ts` 同样仅限制范围。
- 实测 `/api/site/discoveries?limit=1` 返回 200；`limit=1.5` 返回 503。
- 小数传入 SQL LIMIT，PostgreSQL 报 `invalid input syntax for type bigint: "2.5"`，被包装为临时不可用并附重试提示。
- 建议：校验有限整数并对非法输入返回 400，增加小数参数回归测试。普通页面固定分页不受此问题影响。

## 初轮验证（修复前，修复后结果见文首）

- Node 24.11.1；类型检查、前端生产构建通过。
- 前端测试 31 项、架构/行业信源测试 11 项通过。
- 独立 `saas_radar_test` 库：发现页集成测试 5 项通过；没有运行迁移。
- 用已有模拟预览库启动临时本机 API/web，站点 smoke 共 31 项全部通过，含发现页、RSS、API、MCP。
- 另尝试分析链路测试：2 项通过，6 项因 `MODEL_CALLS_ENABLED=false` 被安全阀阻止；未开启模型调用，不将这些结果认定为代码回归，也不声称本轮全套 577 项通过。
- 浏览器工具没有可用浏览器，视觉与真实点击交互仍未验证。
- 未调用真实模型，未完成真实样本的召回率、精选质量和收入口径评估；默认 T2 门槛 76 是否适合 Reddit/HN 仍待标注校准。
- 未更改环境、认证、生产配置，未提交或推送。

## 后续验收顺序

1. 已完成：修复上述两项，并补充针对性回归验证。
2. 用实际博客/Reddit/HN 材料跑完整采集到展示流程，记录抓取成功率、正文获取率和各类入选数量。
3. 以用户认可的晨读材料做标注，按既有校准流程评估门槛；不凭感觉调低分数。
4. 补浏览器桌面与移动端交互验收。

第一版代码已在 `ff4aac2`；本轮两项修复尚未提交。最新交接已写入 `WORKLOG.md`，旧交接保留作历史，后续以 Git 状态为准。
