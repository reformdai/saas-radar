# 出海 SaaS 信息站：讨论记录与后续计划

更新：2026-10-03。状态：第一版改造与本地独立数据库验证完成；按用户要求，明天继续数据接入。

## 当前现场

- 本地目录：`/Users/reformdai/Code/ai/aihot`。
- 上游：`https://github.com/KKKKhazix/AIHOT`。
- 初始版本：`3343fe2`，分支 `main`；当前跟踪 `origin/main`。
- 个人 Fork 已从 `reformdai/AIHOT` 改名为 `reformdai/saas-radar`：https://github.com/reformdai/saas-radar 。已核实保留与 `KKKKhazix/AIHOT` 的 Fork 关系。
- 本地 `origin` 指向个人 Fork，`upstream` 指向原仓库；已成功 fetch 个人 Fork，没有合并、提交或推送。
- GitHub CLI 已由用户登录为 `reformdai`；沙箱内验证失败，放开沙箱后 API 读取与改名成功，无需重新登录。
- 已阅读 `AGENTS.md`、`CLAUDE.md`（引用 AGENTS.md）和 README；沿用项目现有规则、目录和验证流程。
- 已安装锁文件依赖，使用缓存的临时 Node 24.11.1；当前开发分支为 `feat/saas-radar-v1`。未修改密钥、迁移数据库、提交或推送。
- 克隆时现有 Git 配置将 HTTPS 重写为 SSH；此次仅通过命令级环境变量忽略全局配置以 HTTPS 克隆，未修改全局设置。

## 用户已明确的目标

基于 AIHOT 二开一个个人使用的出海 SaaS 信息搜集和展示平台。每天开工时浏览值得关注的产品、经营与获客进展、用户问题及关键词变化，随后自行筛选判断和调查。当前重点是稳定的信息输入。

用户认可晨读样刊，尤其是 Reddit 原帖与创始人博客。所有新能力应尽量接入 AIHOT 的既有后台、任务与展示流程。

## 已讨论的候选功能（待代码评估及版本范围确认）

1. 复用 RSS、网页列表等采集能力，增加出海 SaaS 信源。
2. 增加定时搜索以发现未知产品、作者和用户讨论；搜索 API 选型、数据授权与预算待确认。
3. 修改分类、精选标准和摘要提示词，关注产品、付费、获客、用户任务和市场变化。
4. 卡片保留事实、原文链接、证据边界及待调查问题；区分搜索摘要与成功读取的原文，明确自报收入及其统计口径。
5. 评估“近期动态”和“今日发现”并存：现有超过 48 小时的旧文归档规则可能使有价值的历史复盘无法进入晨读。
6. 评估手动添加、收藏、标记无用和关注来源等个人反馈入口。
7. 关键词趋势需要可比较的时间序列数据，不能用讨论热度代替搜索增长。

## 后续待办：微信信源（本版不实施）

用户明确要求仅记录待办，先完成当前改造和本地预览。

- [ ] 接入 `wechat-digest` 的“出海产品”机会卡，保留摘要、`claim_type` / `claim_note`、待验证问题及回到本地查看证据的入口。
- [ ] 群聊内容接入前确定私人访问边界：AIHOT 原有前台默认公开，不能直接自动发布真实群聊。
- [ ] 机会卡中发现的公开产品和文章链接进入雷达继续调查；完整卡片需适配现有外部导入接口，该接口目前主要收标题和链接。
- [ ] 后续接入微信公众号文章推送作为信源；评估现有 `mp_account` 付费采集与其他出口。不涉及向微信发送消息。

本次只阅读 `wechat-digest` 相关源码与规则，没有修改该项目或读取真实聊天数据库。

## 当前收尾与启动状态

- 用户要求继续现有改造，完成后启动本地项目供查看。
- 第一轮 Claude 实现和 Codex 前端收尾已完成；架构及信源测试 11 项、前端测试 31 项、完整测试 577 项通过；类型检查与前端构建通过。独立数据库迁移及集成测试已验证。
- 第二轮 Claude 完成后端类别过滤、类别绑定游标和日期范围校验后达到额度限制；Codex 已补齐前端筛选控件、移动导航、简化解释、跨年时间展示、卡片操作层级和回归测试。
- 第二轮任务保存在 `/private/tmp/saas-radar-frontend-followup.md`，输出 `/private/tmp/saas-radar-claude-frontend.jsonl`；执行进程已退出（exit 1）。
- 用户已允许 Codex 完成前端收尾和预览准备。已补齐四类筛选、筛选游标绑定、加载/空状态反馈、手机端发现入口、跨年完整日期、卡片操作层级，以及后续筛选回归测试。
- 已按授权新建独立 PostgreSQL 17 容器 `saas-radar-local-20261003`（仅 127.0.0.1:55432），创建 `saas_radar_preview` / `saas_radar_test`，运行已有 38 个迁移；预览库加入四张明确标为演示的模拟卡片，采集/模型/通知/IndexNow 全部关闭。没有接触已有容器数据库。
- 验证：类型检查通过；前端构建通过；前端测试 31 项、完整测试 577 项、架构/信源测试 11 项通过；`git diff --check` 通过。数据库迁移和测试均在独立库完成。
- 本地 API/前端启动受沙箱监听限制，当前会话结束前未留下运行中的服务；预览库、启动命令和模拟卡片均已准备。站点 smoke 和真实浏览器交互仍未验证，明天启动后先完成这两项。
- 运行时采用缓存的 Node 24.11.1：`/Users/reformdai/.npm/_npx/172230ac6533d490/node_modules/node/bin/node`，不安装全局依赖。

## 获得正面反馈的内容参考

- Tally 创始人复盘：https://blog.tally.so/6-years-in-6-million-far/
- Reloops 买断销售复盘：https://www.reddit.com/r/Startup_Ideas/comments/1wpx4mg/i_made_18k_this_month_in_gross_sales_from_saas/
- Superblog 经营复盘：https://www.reddit.com/r/SaaS/comments/1wbuial/186k_revenue_from_my_bootstrapped_saas/
- 报告自动化讨论：https://www.reddit.com/r/agenticanalyticstalk/comments/1w541u5/what_would_it_actually_take_for_an_agent_to/

这些是内容偏好样本，不是已经验证的商业机会。收入为作者披露，未核验后台；报告讨论曾能从搜索结果读取，但直接打开出现失败。

## 下次工作顺序与验收

用户指定：代码开发由 Claude Code 执行，Codex 负责梳理需求、检查现场及交叉评审。同一时刻只有一个写入者。

第一版范围：站名「出海 SaaS 雷达」；分类为产品发现、收入与获客、用户问题、市场变化；博客 RSS 与公开免费搜索接口优先，X 和付费网页搜索服务待后续确定预算再接入。今日发现作为独立视图，保留旧文归档与通知规则。

实施前明确初始信源、搜索服务与预算。不得自动修改 `.env`、认证、全局配置、CI/CD，不得执行数据库迁移或 schema 修改、删除文件、提交、推送、生产部署；涉及这些操作时先给出具体方案并按用户规则取得授权。

- [x] 克隆项目，核对分支、版本、远程地址和原始工作区状态。
- [x] 保存讨论结论与待确认事项。
- [x] 关联个人 Fork，改名为 `saas-radar`，配置 `origin` / `upstream` 并验证。
- [x] Claude Code 完成只读代码盘点，RSS、JSON 搜索可复用，今日发现及材料标记无需 schema 修改。
- [x] 用户批准建议的第一版范围；在 `feat/saas-radar-v1` 分支实施。
- [x] Claude Code 完成第一版代码（未提交），记录见下节；待 Codex 只读评审。
- [ ] 用晨读样本评估选材、校准门槛；在有测试库的环境补跑数据库测试和站点 smoke。

## 第一版实施记录（Claude Code，2026-10-03）

### 实际完成

- 行业包 `industry/`：站名“出海 SaaS 雷达”、行业词 `SaaS`、MCP 前缀 `saasradar`、抓取 UA `SaaSRadarBot`；四个分类 `products` 产品发现、`growth` 收入与获客、`problems` 用户问题、`market` 市场变化；新标签词表、平台实体（Stripe、Paddle 等）、身份词典和 18 个主题；模型榜与 Codex 重置监控关闭；更新日志改为第一版说明。
- 提示词：预筛、评分标准、内容理解、领域翻译、结构化、摘要与报告改为出海 SaaS 口径。评分标准保留内容类型、五维加权（权重数字未改）、噪声压制、安全边界和事件口径校正，只替换“什么重要、什么是噪声”。内容类型的 key 沿用原值、含义按 SaaS 重新解释。门槛未改。收入数字要求注明作者自报、时间段和口径。
- 待调查问题：内容理解新增 `researchQuestion` 字段，存进 `analyses.output`（jsonb，**无 schema 变更**），与推荐理由分开展示。
- 信源 `industry/sources.json`：Tally、Plausible 博客 RSS（T1）；Reddit r/SaaS “first customers” 搜索 RSS（T2）；HN Algolia `saas`、`first customers` 两个 `json_list`（T2，`url` 缺失时用 `objectID` 拼 HN 讨论链接，时间用 `created_at_i` 秒级时间戳）。**Tally `https://blog.tally.so/rss/` 和 Plausible `https://plausible.io/blog/feed.xml` 两个地址是按站点惯例填写的，试抓记录里没有写出具体地址，需 Codex 核对后再上线。**
- 今日发现：`packages/backend/src/publication/discoveries.ts`（只用 `scope.ts` 的 `selectedCondition` / `pendingReleaseCondition`）→ `/api/site/discoveries` → 页面 `/discover`，侧边栏和“更多”页有入口。按 `discovered_at DESC, article_id DESC` 键集分页。
  - `discovered_at` 的含义（按源码核对）：`content/materials.ts` 在材料第一次入库时写入 `articles.discovered_at`，发布时原样复制进 `publications.discovered_at`；入选时间是 `selected_ready_at`，公开时间是 `visible_after`。页面只称“本站发现”，并说明发现时间不是入选时间。
  - 旧文按 `articles.backfill_reason` 标“首批导入”（`first-import`）、“旧文”（`stale-on-discovery`）、“历史回灌”（其他回灌）。backfill、热度、日报和推送规则未改。
- 材料获取状态：按源码核对 `body_status`：`ok` 表示有正文（RSS 内容长于 280 字且非“阅读更多”预告、`summaryIsBody`，或原网页提取成功），`pending` 只有标题或订阅摘要，`unconfirmed` 原网页抓取失败，`none` 无正文。卡片显示“正文已获取 / 仅摘要 / 仅标题”，说明文字写明不代表核实。
- 品牌：`logo.svg` 换成项目内的雷达图形 SVG，并用已安装的 `@resvg/resvg-js` 生成 `icon.png`、`icon-192.png`、`apple-icon.png`、`favicon.ico`；日报、周报、月报报头里的 “AI” 换成 SVG 文字 “SaaS”（下载字体包需要授权，暂未用 `scripts/nameplates.ts` 重新生成字形）。未新增依赖、未删除文件。
- README 顶部新增本站说明：实际支持、信源与搜索范围、数据边界、需要配置的环境；`docs/architecture.md` 出口表加 `/discover`；`scripts/smoke.ts` 加 `/discover`。
- 必要的代码适配：`publication/items.ts` 与 `apps/api/src/routes/v1.ts` 里写死的示例分类 `tip` 不再属于类型，改为不依赖具体 key 的写法（行为不变）。
- 测试：示例行业的分类和标签换成新行业对应项（`ai-models` → `products`、“模型发布” → “产品发布”，预筛识别词改为“宽召回的相关性预筛”），断言未删减；`analyze.test.ts` 增加 `researchQuestion` 存储断言；新增 `tests/saas-radar.test.ts`（无库：信源配置、HN/Reddit 本地样本映射、状态文案、分类主题提示词一致）和 `tests/discoveries.test.ts`（需库：过滤、排序、发布闸门、旧文标记、材料状态、分页、路由与非法游标）。

### 验证结果

- `npm run typecheck`：通过。
- 无库测试（临时 Node 24.11.1）：`saas-radar`、`architecture`、`rss-links`、`rss-xhtml`、`url`、`url-identity`、`web-list-date`、`markdown-body`、`cache-expiry`、`relation-eval`、`leaderboard-access`、`leaderboard-worker` 全部通过（47 项）。
- `npm run build -w @aihot/web`：通过；`node --test apps/web/tests/*.test.ts`：31 项通过。
- **未验证**：PostgreSQL 集成测试（含新 `tests/discoveries.test.ts` 和改过示例的旧测试）——本机没有 PostgreSQL，任务边界不允许建库和迁移；站点 smoke 与页面实际渲染——需要运行中的站点和数据库；真实外网抓取——由 Codex 负责。

### 剩余前提与待办

1. Codex 核对 Tally、Plausible 订阅源地址，试抓 HN 两个关键词；部署到服务器后在后台预览抓取 Reddit 搜索订阅源。
2. 在有 `*_test` 库的环境跑 `node scripts/migrate.ts` 和 `npm test`，再启动站点跑 `node scripts/smoke.ts`，看一眼 `/discover`。
3. 用晨读样本标注 100–200 条，按 `docs/selection.md` 校准门槛；T2 门槛 76 是 AI 示例站的数值，Reddit 与 HN 帖子可能很少入选。
4. 用户确认 `industry/pages/` 的使用规则和隐私说明。
5. 可选：授权下载 `@fontsource/noto-sans-sc@5.3.0` 到临时目录后运行 `node scripts/nameplates.ts <目录>`，把报头里的 “SaaS” 换回字形路径。
6. 后续版本：关键词趋势、X 与付费搜索（预算待定）、收藏/标记无用/关注来源等个人反馈入口。

当前验收：代码完整克隆、上游源码保持原样、未提交/推送/部署；明天第一步是启动独立预览服务并检查 `/discover`，随后开始 RSS/公开搜索数据接入。
