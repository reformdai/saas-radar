# Claude Code 开发任务：saas-radar 第一版

用户已授权开工，明确代码开发由 Claude Code 执行。先读取 AGENTS.md、README.md、docs/customize.md、docs/plans/saas-discovery.md、WORKLOG.md。Codex 在开发期间只读评审，Claude 是唯一代码写入者。不派其他代理。

## 范围与取舍

1. 基于现有 AIHOT 完成个人「出海 SaaS 雷达」。四类：产品发现、收入与获客、用户问题、市场变化。配置、主题、文案与提示词保持一致。保留既有评分结构和默认门槛，不凭空校准数值。
2. 使用现有 RSS 和 json_list 提供初始信源：Tally、Plausible 博客，以及 HN Algolia 的 SaaS、第一批客户等具体关键词搜索。公开接口需有明确的字段映射、原文链接、发布时间。可用性核实以本文件后续的信源检查记录为准。Reddit RSS 若未通过试抓则仅给出后台配置说明或禁用候选，不宣传可用。不接付费网页搜索、不虚构能全网搜索。
3. 新增「今日发现」页面/入口，经现有 publication 读取层读取已精选、公开可见材料，按发现时间排序，允许有价值的旧文。清晰显示发表时间与发现时间。不改已有 backfill、热度、日报/通知规则，首批导入不要误宣称实时新闻。阅读权限、撤回、许可规则保持一致，分页稳定。先按源码证明当前 discovered_at 字段含义；不能将初始发现时间误当精选时间。
4. 卡片显示材料获取状态。body_status 的含义必须检查，原文来自 RSS 摘要或全文时不能误标「已核实」；合适文案是「仅摘要」「正文已获取」，它不证明事实真实性。收入摘要明示作者自报、时间与口径；保留推荐理由，并新增或用已有文字容纳一个待调查问题，不能把推荐理由和研究问题无说明地混为一谈。
5. 关闭行业无关的模型榜/重置监控；替换品牌为简单项目内 SVG/文本方案，不使用 AIHOT 品牌，不新增依赖、不删除文件。
6. 更新项目 README，明确第一版实际支持与接入方式、用户需要配置的环境、搜索范围和数据边界。条款和隐私说明不擅自作法律承诺，留待用户上线前确认。

## 技术与权限边界

- 不修改 `.env`、密钥、认证或全局配置，不读取或输出敏感凭据。环境变量通过命令临时传入，不落盘密钥。
- 不修改 CI/CD、生产部署配置或数据库 schema/迁移，不运行 migrate 或创建数据库；若遇必要数据库变更，给出具体原因与文件，先停在设计阶段。
- 不安装全局依赖。不删除文件、git reset/clean、不提交、推送或部署。已有 `.worktreeinclude` 属于用户/工具改动，保留。
- 已授权必要的普通项目代码/配置修改及项目本地依赖安装。源码修改必须遵守原项目架构，前端只通过 API、公开数据只从 publication 读取。
- 核心 npm 包名保留 @aihot/*，避免无必要的全局包重命名。对已有测试中的示例行业作最小必要适配，不能删测试或弱化断言以过关。
- 不在开发/测试中调用模型或付费服务；COLLECT_ENABLED=false、MODEL_CALLS_ENABLED=false、FEISHU_*_ENABLED=false、INDEXNOW_SUBMIT_ENABLED=false。
- 本机 Node 原为24.9.0，项目要求>=24.11。Codex 正准备 npm 临时 Node24.11.1，不修改系统版本。

## 验收

- 类型检查和前端构建通过；相关无需数据库测试通过。
- 新页面、API 与契约一致；用户能看见来源、时间、材料获取状态和研究线索。
- 初始 RSS/公开搜索信源配置能解析结果（外网试抓由 Codex 负责，Claude 的测试用本地样本）。
- 对今日发现的过滤/排序/权限及状态文案补充必要回归验证，优先现有测试机制。
- PostgreSQL 集成测试和站点 smoke 如缺测试库/环境，报告「未验证」及原因，不能宣称通过。
- 更新 saas-discovery.md 任务状态，列出实际完成内容、测试结果和剩余环境前提。

## 已核实的运行前提

Codex 已通过真实公开 HTTP 请求试抓：Tally RSS 200 / 15条；Plausible Atom 200 / 10条；Reddit `https://www.reddit.com/r/SaaS/search.rss?q=first%20customers&restrict_sr=1&sort=new` 返回200 / 25条；HN `https://hn.algolia.com/api/v1/search_by_date?query=saas&tags=story&hitsPerPage=5` 返回200 / 5条。Reddit 搜索RSS可以纳入首批启用信源，但须注明服务器部署后的可用性仍需试抓，不保证全量覆盖。

HN 部分记录不含 url，必须使用 objectID 构造 `https://news.ycombinator.com/item?id={objectID}`，发布日期使用 created_at 或 created_at_i（epoch_s）；不能凭空假定每条都有 url。Reddit Atom 的 content 是否为完整自述要核对本地提取逻辑，不将节选等同核实。

临时 Node 24.11.1 已可用，执行命令可通过 `npm exec --yes --package=node@24.11.1 -- <command>`。Codex 正安装锁文件依赖，Claude 不并行运行依赖安装。

现在实施以上范围，无需再询问已批准的第一版方向。遇用户红线或真正影响范围的选择再停下说明。完成后返回改动摘要、验证结果和待办。
