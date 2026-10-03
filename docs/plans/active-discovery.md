# 晨读发现与主动搜索

2026-10-03：用户批准推进；Claude Code 唯一写产品代码，Codex 验收。保留当前未提交修复，不提交、推送、删除、迁移或更改环境/认证。

## 目标和步骤

1. 今日发现从仅精选改为已处理、公开可见的收录内容，按发现时间排列，保留旧文与首次导入。精选、日报、热度门槛不变。
2. 主人已选 Tavily，后续额度或质量不足再接 Exa/其他工具。每天最多20次搜索（16 basic、4 advanced），月上限900 credits，预留100 credits供用户在平台其他用途。只在显式启用且配置 Key 时运行；不启用自动付费。
3. 服务确定后，复用 worker 调度、采集、材料分析和发布流程，实现定时搜索与证据来源记录。

## 本轮涉及文件与验收

- publication/discoveries.ts、discover 页面、相关测试、README。
- 未入选公开内容能展示；撤回/不可公开内容不展示；精选发布闸门仍有效；旧文、分类和分页正确。
- typecheck、web build、前端测试、discoveries 集成测试（已有独立测试库，无迁移）。
- 页面准确说明收录与精选差别，不让打开页面触发采集或模型。

## 进度

- [x] 核对已有未提交修复和交接记录。
- [x] Claude 实施晨读发现改动，Codex 独立验证。
  - `discoveries.ts` 直接复用 `listedCondition`（public + eligible + 精选发布闸门）；已核对 eligible 不排除 backfill，所以保留首批导入、旧文和历史回灌。精选、主题、报告和热点规则未改。
  - 卡片标“精选”，未入选无推荐理由；已有待调查问题在未入选内容上也保留，避免损失自行判断的线索。同步页面说明、空状态、关于页、契约注释和 README。
  - Codex 独立验证：typecheck、web build、前端31项、后端信源/架构/发现集成17项、git diff --check 全通过。集成测试仅使用既有 saas_radar_test，未运行迁移。真实采集、模型调用、通知关闭。
  - 无服务重启、提交、推送或部署；真实浏览器交互未验收。既有未提交修复全部保留。
- [x] 用户确定主动搜索范围与服务：Tavily 先行，不同时接 Exa。
- [x] Claude 实施 Tavily 主动搜索，Codex通过typecheck和27项后端相关mock测试；详见tavily-implementation.md。
- [ ] Tavily阶段前端构建/前端测试与浏览器验收、真实API试跑、下午使用教学。运行中的前端不保证已包含本轮新卡片标记。

## Tavily 实施范围

- API 依据 https://docs.tavily.com/documentation/api-reference/endpoint/search ，计费依据 https://docs.tavily.com/documentation/api-credits （2026-10-03 核对）。Search basic每请求1 credit，advanced每请求2 credits；每月免费1000 credits。禁用 auto_parameters 和自动 Research/Crawl，不隐式升级搜索深度。
- 复用 worker 日任务（北京时间晨间）、receipts 的持久化结果与预算保护、现有材料导入/去重/正文获取/分析/publication。新代码使用已有依赖，不迁移，不改真实 .env、密钥、认证、CI/CD，不提交推送。
- 查询计划：Reddit问题6、创始人博客6、细分需求4、新产品与追查4；稳定模板与 AI 生成查询结合。生成失败回退固定模板，生成调用走现有模型回执。查询只用公开主题与公开内容，不读取微信群聊或密钥。
- 搜索参数：每次最多5个结果；明确来源、搜索关键词和发现时间；搜索摘要不能充当已获取正文，不能把搜索结果分数当平台评分。限制日次数及月credit，失败/重试也占保守预算，同日重跑不得重复付费或丢失已返回未导入结果。
- 暂不实现 Tavily Extract，已有正文获取链路先行，遇失败保留材料状态。后续验证需要补抓再接 Extract（之前成本估算是预算示例，不代表本版已实现）。
- 前台复用今日发现展示，卡片保留检索来源/查询等证据；后台复用 job_runs/信源状态定位运行结果，README 给出安全启用步骤及检查方法。
- 验收：本地mock覆盖鉴权、参数、深度计费、额度停止、异常、重跑恢复、去重/元信息和任务安全阀；已有独立test库，不迁移；typecheck及必要测试。构建在临时目录验证，避免覆盖运行中前端的静态文件；如必须构建常规目录先安排维护窗口。
