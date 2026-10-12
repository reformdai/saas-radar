# Claude Code 实施：保留 WeFlow SSE 的逐库只读模式

主人最新明确授权：“行，你们两个先去解决……不要再让我操心”。现在进入实施阶段，不要再要求主人选架构或重复提供信息。Codex 独立验收，Claude 是唯一产品代码写入者。必须保留 WeFlow → SSE，不改成另一个独立采集服务或定时 HTTP 拉取。

## 写入工作区与保护边界

- 只在 `/private/tmp/weflow-keymap-worktree.dzvEHM` 写产品代码，分支 `fix/per-db-sse-reader`，基于原本机 WeFlow HEAD。原仓库 `/Users/reformdai/Code/ai/WeFlow` 不改，四个 dirty helper 不碰。
- 临时工作区 node_modules 是原仓库既有依赖的软链，不能写软链内任何文件、不能安装依赖。使用已有 koffi、SQLCipher `/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib`、现有 Node/TypeScript。
- 当前库 typecheck 基线已通过。新增测试只用自己创建的合成数据库/密钥/消息，不能读取真实 keys、Library、真实聊天或其他账号；不能附加/Hook 微信，不能退出重登或改系统设置。
- 普通功能代码修改获准；真实 .env/密钥/Token/认证配置、数据库迁移、删除、提交、推送、部署、全局依赖/配置仍禁止。不要派子代理。
- 参考初始任务 `/Users/reformdai/Code/ai/aihot/docs/plans/wechat-opportunities-claude-task.md` 和现有计划的证据；内部完整新设计以本阶段实现为准。先按代码实际依赖形成最小实现，再运行必要验证，不为赶时间省略正确性。

## 成功标准

先修正只读审查结论中的两个缺口：① `size/mtime` 比对不足以完整验证 DB/WAL，必须额外验证副本 WAL generation/checksum/已提交边界及复制竞争，不允许 SQLCipher 静默忽略损坏 WAL 后被当成成功；② 接收桥回看 60 秒不保证任意迟到消息，reader 必须根据批次内容变更与可靠身份判增量，不能声称现有 60 秒回看已经覆盖迟到。不要重复申请已获得的普通实现授权或要求主人再提供已知 key-map 路径；真实配置阶段才按红线处理。

1. 在 WeFlow 内新增显式 opt-in 的逐库 raw key 读取模式，原生 master-key 模式保持原默认行为。可以通过新的启动参数或一次性进程参数指定显式账号源目录、key-map 文件位置及群白名单，不必修改当前用户真实配置或原单 key 输入。
2. 读取器只通过普通文件读取复制加密源 DB/WAL；SQLCipher 只打开临时副本。不能让任何可写 SQLite/SQLCipher 连接接触源文件；不要执行原生 native 开账号/监控或防撤回逻辑。校验复制一致性、提交边界、WAL checksum/salt 或其他明确可验证条件；不一致、缺密钥、不支持 schema、路径越界必须报错/隔离，不推进扫描水位。不把仅看 mtime 称绝对一致，不把损坏/不匹配 WAL 丢掉后返回主库旧内容称成功。
3. 逐库消息表的账号/群对应必须用稳定群 ID 和确定性映射（例如 MD5 绑定消息表并校验 session/contact 元数据，按实际 schema 设计），禁止用群名/成员名或模糊匹配。群名同名、同一成员在多群、分片本地 ID 相同均不能串群。输出的 sessionId 始终是实际群 ID，rawid/serverId 保留字符串不经 JS Number。
4. 最少支持实际 SSE 与恢复查询依赖：会话列表、群白名单查询、多消息库合并、消息增量、可用显示名、必要表统计/execQuery 或等效调用路径、文件批次变化事件。可以对非目标的媒体/朋友圈/修改等方法明确返回 unsupported，不能默默回退到 master-key native。
5. 沿用现有 httpService `/api/v1/push/messages` SSE 长连接与 `message.new`/`message.revoke`，沿用 `/api/v1/messages`、`/api/v1/sessions` 的完整兼容契约供补漏与桥注册。新模式批次读取可延迟，不新建替代独立服务，查询补漏不能替代 SSE 主通道。源更新只有新数据批次被验证后才触发事件。
6. 不只用消息时间过滤来判增量；批次比对/稳定身份覆盖迟到消息及同秒消息。撤回必须有可验证的定位依据或更新检测，不把任意消失消息都猜成撤回。缺原始顺序时说明稳定排序与真实顺序的界限。
7. 首次加载与后续增量必须区分，失败重试不丢数据；新分片缺 key 明确告警。发生账号路径变化时拒绝继续使用旧 key/cursor。先仅做数据接入，不实现机会卡/模型调用。

## 验证与交付

- 合成夹具需要是真实 SQLCipher 加密 DB + WAL（现有 C API via koffi/ctypes 均可），包括 session/contact、两群同名、同成员跨群、多分片相同 local_id、超过安全整数的 server_id、乱序/迟到、撤回、错 key、缺新分片 key、复制期间源变动。
- 检查源目录文件集合与内容不被 reader 写入；写权限禁止的源也能采集。测试中修改源是模拟微信自己的 writer，不是 reader；区分清楚。
- 至少跑 typecheck、reader 的有意义回归和实际本机 SSE 连接/恢复查询模拟；必须真正使用现有 WeFlow HTTP/SSE 代码或有清楚依据的集成，不仅测试自行写的假 SSE 服务器。
- 不要求跑 electron-builder 安装/发布打包；可使用现有 Vite 构建选项或局部编译验证 worker 部署路径。不要覆盖原工作区运行构建。
- 文档写在临时工作区 docs/ 对应说明，记录准确启动命令、群白名单、所有失败/停止行为、尚未完成的实际主微信验收。API Token 使用合成测试值；不要要求主人重提或打印真实凭据。
- 完成后返回改动清单、实际测试命令/结果、已运行的完整链路与仍需真实验收的边界；不得声称免封、零资源影响或主号真实接通，除非有本轮合法验证证据。
