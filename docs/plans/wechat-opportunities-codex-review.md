# Codex 独立验收记录

## 2026-10-03 实施期间

- Claude Code 在 `/private/tmp/weflow-keymap-worktree.dzvEHM` 的 `fix/per-db-sse-reader` 实现；Codex 不修改其工作副本。原 WeFlow dirty helper 不改。当前仓库由 Codex 修改接收桥的明确群标识校验，两个写入者使用不同项目/分支/工作区。
- 原 WeFlow 工作副本 typecheck 基线通过。aihot 旧 SSE 接收桥 8 项通过（本机 HTTP 测试需放行监听）；本次增强后 10 项通过，aihot typecheck 通过。
- 已复现并修复：pulledEvent 忽略消息内 sessionId，能把明确标成 B 群的响应按 A 群请求导入。现在顶层补漏响应必须包含匹配 talker，行内显式 sessionId/talker 也必须一致；不一致或缺页群标识抛错，消息不导入、水位不前进。测试覆盖同名群和身份冲突。原 WeFlow httpService.handleMessages 确实总返回顶层 talker，契约依据成立。
- 独立只读取得真实核心库的列结构（没有正文、联系人行、真实群 ID、表 hash 或 key 输出），保存 `/private/tmp/weflow-core-schema-20261003.json`。仅 SQLCipher `mode=ro&immutable=1`，范围为已确认当前账号，数据库主体；不是 WAL 验收。
- 真实 `Name2Id` 无显式 id 列，仅 `user_name TEXT PRIMARY KEY, is_session INTEGER`；发言人 `real_sender_id` 应关联该库 rowid。真实消息表没有 is_send 列，必须按实际身份及字段判断，夹具不能只验证猜测 schema。消息有 `server_seq`、`WCDB_CT_message_content` 等，压缩与 sender 表关系必须核实。

## 待作者回检

1. 目前新 sqlcipher.ts 的 execRaw 错误中包含 SQL 片段；设置 PRAGMA key 的错误不得泄露实际 raw key，需红处理/移除 SQL 日志。当前只用于合成测试，尚未运行真实凭据。
2. readColumn 将 int64/bigint 转 Number 有精度风险；即使主查询 CAST(server_id AS TEXT)，execQuery/其他路径也要保证稳定消息 ID 不经 Number。超过安全整数时返回精确文本或可靠 BigInt，不得靠注释宣称安全。
3. reader 的内容 diff 不能只触发原 messagePushService 旧流程而不改变筛选：旧 pushSessionMessages 按 previousTimestamp-2 查询，且部分候选按时间跳过；十分钟迟到的旧时间消息不会因一个 monitor 信号自动被补齐。需真实测试整个新模式 SSE 能推送此类变化，不能仅测 reader diff。
4. 顶层补漏 talker 校验是新要求；新模式必须保持真实 httpService 的完整字段，不仅 messages/hasMore。
5. DB/WAL 一致性验证不能只看 mtime，也不能让坏 WAL 被 SQLite 忽略后视作成功。新 key/分片失败须报缺口并保留进度；基于用户主号约束，真实源文件不能被任何 SQLite 连接打开写入。

本文件是持续验收记录，不是完成报告。真实 WeFlow → SSE 尚未接通；主号真实白名单数据验收和认证配置未进行。

## 2026-10-04 Codex 接手修复

Claude 会话额度耗尽后已停止写入。Codex 接管同一隔离副本，是当前唯一写入者。独立复跑 24 个单测及真实 HTTP/SSE 集成测试通过；验收发现 collector 未接 App 启动、查询依赖真实库不存在的 is_send、新分片枚举仅来自 keymap、首载最多 5000 行导致后续误推历史、降序查询截断后反转导致漏最新消息。先修复这些实际缺陷再交付。

`npm run typecheck` 仅检查前端，通过。额外 Electron 完整检查发现既有其他服务类型错误，需与未改基线逐项对照；不能把前端通过称全部代码类型通过。

## 2026-10-04 主人调整优先级：先公众号

- Claude 会话额度用尽后由 Codex 接手；随后追加只读交叉评审，修正长断线撤回恢复、pending 超窗漏推及 SSE 资源释放。最新全套 38 项 WeFlow 测试与 15 项桥测试通过；最后新增 pending→分配 ID→原地撤回组合用例，reader 共 18 项通过。当前合计 39 项 WeFlow 相关用例，但最后只重跑 reader，未把全部 39 说成最终全量复跑。
- Vite 构建与 aihot typecheck 曾通过，Electron 完整检查和未改 HEAD 对照均为相同 46 行既有错误、无新增错误；最终修正后未重跑全部构建/类型检查。
- 真实主号 7 个核心库经新 snapshot/SQLCipher 的结构读取全部通过，实际 WAL 是已校验 SHM mxFrame=0 加保留旧 generation/预分配尾部。仅检查结构，未读正文。证据 `/private/tmp/weflow-core-copy-check-result-20261004.json`。
- 主人明确提出“实在不行，就先公众号吧”，微信群工作停止在此状态：没有启用主号 HTTP/SSE 认证，没有选真实群白名单，没有实际群正文→SSE→ShipRadar 落库验收。没有宣称接通或免封。
- WeFlow 改动仍仅在 `/private/tmp/weflow-keymap-worktree.dzvEHM`，新增运行文档 `docs/per-db-sse.md`。没有应用回原 WeFlow、没有动原四个 dirty helper、没有提交/推送/部署。临时 scratch 和测试目录保留，不清理。
- 公众号现有实现已确认：`packages/backend/src/sources/mp.ts` 和 `providers/dajiala.ts`，复用 mp_account 信源、回执/预算与文章处理。持续自动采集需第三方 API key 与费用授权；只读核对，不调用付费 API、不改 .env。先前群名单异步问题随方向调整暂不处理。
