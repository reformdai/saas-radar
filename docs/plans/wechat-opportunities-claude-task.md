# Claude Code 接手：逐库读取与 SSE

2026-10-03 22:47，主人允许将未解决的微信采集任务交给 Claude Code 完成。Codex 已完成源码排查与逐库密钥验证，真实 WeFlow → SSE 未接通。

## 本次先独立审查，给出可实施的最小修复

先读本项目 AGENTS.md、README.md、WORKLOG.md 最新交接和 docs/plans/wechat-opportunities.md。只读审查本地 WeFlow 与 Digest 相关源码，评估能否在不干扰主微信的前提下增加逐库读取模式。不要只重复概念或要求主人再次提供已确认的信息：必须给出具体接入文件、必要方法、快照一致性方案、消息身份/群归属规则、可运行的模拟验证设计和实施阻碍。

当前阶段只读。你没有权限执行进程扫描、读取真实密钥/聊天内容、调用外部微信服务或改真实配置。完成审查后返回明确可实施结论；实现与实际配置是不同阶段，不能把主号零风险当成能保证的验收项。

## 主人要求与执行边界

- 延迟 1、2、10 分钟都可以，先以每 10 分钟批量采集设计。禁止把 A 群消息归到 B 群；禁止用群名/模型/最近活跃群猜归属。
- 这是主微信。不得 Hook、附加进程、读进程内存、降级/重启/退出/重登微信、修改 SIP/签名/权限/全局配置；不得写微信源 DB/WAL/SHM，不得启用防撤回 trigger，不得模拟登录或自动发消息。
- 复用已有逐库 raw key。密钥轮换或新增库未匹配时停止该库导入并报告缺口，不能自动提取密钥。
- 优先普通文件读取取得加密 DB/WAL 的一致性副本，SQLCipher 只在隔离副本运行。逐个 cp + mtime 比对本身不能直接作为一致性证明；必须说明怎样识别复制期间 checkpoint/轮转和未提交 WAL，失败时丢弃本批且不推进水位。不要为时效强行打开微信源库。
- SSE 沿用现有接口或完整兼容契约；SSE 流式输出不要求上游每条即时推送。必须覆盖补漏、去重、撤回、迟到消息、消息分片轮转及账号边界。不能用 immutable 库主体验证冒充最新 WAL 可读。
- 主人刚明确纠正：接受延迟，不是更改方案，仍必须使用 SSE。保留 WeFlow → `/api/v1/push/messages` 长连接 → ShipRadar 接收桥，采用现有 message.new / message.revoke 契约。内部文件读取可按批次，但不能把对外链路换成定时 HTTP 拉取、文件导入、手动导入或新建另一个不属于 WeFlow 的采集服务。现有查询接口只用于断线补漏，不能取代 SSE 主通道。
- 当前先解决数据接入，不开发机会卡或模型调用。后续机会合并重新设计，不沿用 Digest 的合并实现；Digest 仅参考密钥、解密及读取。
- 禁止删除、回滚、提交、推送、部署、新迁移、新全局依赖、更改 .env/密钥/Token/认证或全局 AI 配置。不要派子代理。每次答复称呼主人，使用中文。
- 当前审查不写任何产品文件；Codex 负责后续审核。已有用户/其他工具改动不得覆盖。

## 仓库与现场

- 当前仓库 /Users/reformdai/Code/ai/aihot，feat/saas-radar-v1，HEAD cae4914，已推送。真实桥 scripts/weflow-bridge.ts、packages/backend/src/wechat/{bridge,store}.ts 已提交；新的机会卡计划未提交；.worktreeinclude 原有，保留。
- WeFlow /Users/reformdai/Code/ai/WeFlow，当前本地 4.3.0。四个原有 dirty helper 二进制（resources/key/macos/universal/{image_scan_helper,libwx_key.dylib,xkey_helper,xkey_helper_macos}），不覆盖。WeFlow.app 已启动到首次配置欢迎页，没有输入密钥或配置账号。
- Digest /Users/reformdai/Code/ai/wechat-digest。只读其规则和源码；尤其 scripts/decrypt_live.py、wechat-mac-reader/lib/wechat-db-decrypt-macos/{find_key_memscan.py,decrypt_db.py}。现有 live 脚本普通可写连接源库，禁止直接运行。不要读取 wechat_keys.json 的内容，也不要搜索其他真实凭据。
- 主人已确认当前账号；计划文件记录了明确 db_storage 路径。当前阶段禁止直接访问 Library、真实 DB 或账号内容，不枚举其他账号。

## 已确认，避免重走弯路

1. WeFlow 已支持多库。decryptKey → chatService.connect → wcdbService.open → wcdbWorker → wcdbCore.open → wcdb_open_account(sessionDbPath, hexKey, handle)。后续 native 枚举并读取多个消息库。
2. WeFlow 作者 issue #917 明确说明：其他工具拿到的是派生密钥，WeFlow 需要主密钥，不能直接互用。https://github.com/hicccc77/WeFlow/issues/917 。Mac helper 日志识别 [MASTER] hex64=。不能再建议把 session raw key 填入原输入框。
3. 仅对当前账号验证：session、contact、message_1..5 的逐库 raw key 首页 HMAC 和 SQLCipher mode=ro&immutable=1 的结构计数均通过（七库）。各自 raw key 再按 SHA512/256000/salt 当 passphrase 派生，七库均不通过。message_resource.db 已存 key 校验失败；message_0.db 不存在。无正文读取、无明文导出。以上不证明最新 WAL 可读或全库完整。
4. 隔离 Node 预加载 libWCDB 后 InitProtection -101、wcdb_init -1006；只属于独立探针，不是实际 Electron 应用的错误结论。不能绕过保护或继续猜 ABI 调 native with_key cursor。
5. 本地缺 native 读取器及主密钥 helper 的源实现。代码替代模式应绕开对该原生读取器的依赖，不修改/绕过它的保护，不替换 dirty helper。
6. 实际 SSE 依赖：electron/services/httpService.ts 提供 /api/v1/push/messages 和 /api/v1/messages；messagePushService.ts 调 getSessions、getNewMessages、getMessageTableStats、execQuery、显示名/群昵称；chatService.setupDbMonitor → wcdbService.setMonitor 提供变化事件。只改 open() 不足以修通。
7. 源码参考下载只读存在 /private/tmp/weflow-key-reference-81ba42c976/（zhuobichen/weflow-cli，commit 81ba42c976888b1521307a494b6d88f25411ef96）及 /private/tmp/wcdb-cipher-reference/（Tencent/wcdb，commit 39dd797099d41cf1953d5668acd8cb608016c599）。前者主密钥自动适配是 Windows 版本，不能当作 Mac 4.1.15 补丁。
8. /private/tmp/weflow-key-compatibility.py 的五项合成校验通过；脚本仅作此前诊断，不运行它访问真实 keys/DB。

## 返回要求

明确回答推荐方案能否同时做到“可靠群归属、分钟级增量、微信源文件零写入”；给出证明方式和不能保证的部分。列出最小改动文件与新增方法、测试夹具、源码/证据依据。若需要新权限或改变实现方向，给出具体动作和影响，不能泛泛说需要更多信息或要求主人重复获取密钥。不得声称已经接通真实 SSE。
