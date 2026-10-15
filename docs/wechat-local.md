# 本地微信群消息与私人摘要

当前项目自带本地读取器，不调用 WeFlow、`wechat-digest` 服务或脚本，也不读取它们导出的明文缓存。旧 SSE 桥保留以免破坏已有改动，但新路线不使用它。

## 运行边界

- Mac 上的采集器读取明确账号的微信 v4 `db_storage`，按稳定群 ID 白名单查询。群名只用于展示。
- 使用已取得的逐库 raw key，不自动获取密钥、附加微信进程、修改微信或系统设置。
- 普通文件复制源 DB/WAL，检查前后文件指纹、SHM 双头与提交水位、WAL checksum/salt 和提交帧；SQLCipher 只打开隔离副本。复制不是原子快照，源发生变化或校验失败就拒绝本批，下一轮再试。依据：[SQLite WAL 文件格式](https://www.sqlite.org/fileformat2.html#walformat)、[WAL 索引格式](https://www.sqlite.org/walformat.html)、[SQLCipher raw key API](https://www.zetetic.net/sqlcipher/sqlcipher-api/#key)。
- SQLCipher 副本仍加密；临时目录仅当前用户可访问，正常退出自动清理。异常强制终止可能遗留临时目录，不自动扫描清理其他目录。
- 首版读取文字、链接/引用卡片和能定位目标的撤回。图片、语音和视频不转写，不承诺摘要覆盖这些媒体内容。
- 每次重查固定接入起点之后的数据，通过消息内容指纹识别新增/修改/迟到消息。没有使用“最新消息时间”跳过迟到记录；早于接入起点的消息不在采集范围内。
- 撤回以 XML 中明确的目标 server ID 或之前记录的同库同 local ID 对应关系定位；无法定位的记录单独待处理，不猜测目标，不阻断其他正常消息，也不推进该群的完整同步水位。日志显示 pending 和 incompleteGroups；相关群不能被视为完整同步。分片被替换后不沿用旧 local ID 映射。尚无 server ID 的发送中消息留待下次采集。
- 消息 ID 用字符串，原文保留在私人表；不进入公开文章、RSS、公开 API 或 MCP。

## 依赖和独立配置

推荐用下方 Docker 方式，镜像自带 Node.js 24、Python、SQLCipher 4 和 libzstd，不需要在宿主机安装这些依赖。直接运行脚本时需要 Node.js 24、Python 3.10+ 和 SQLCipher 4；Python 3.14 使用标准库 `compression.zstd`，较早版本使用系统 libzstd。Mac Homebrew 和 Linux 动态库位置自动发现，也可用 `--sqlcipher-lib` 指定。

key-map JSON 的键是相对 `db_storage` 的路径，值是对应库的 64 位十六进制 raw key，例如结构为 `session/session.db`、`contact/contact.db`、`message/message_1.db`。此处不提供真实或示例密钥。所有现存消息分片都必须有对应密钥，缺失时明确报错，不能只读部分库并宣称完整同步。

在下线参考项目前，需把所需密钥保存到用户批准的独立私有位置；采集状态也使用独立路径。密钥不进入仓库、命令行参数、日志、模型或浏览器。命令行只传密钥文件路径。不要让运行参数继续指向待下线项目。

## 列群和启动

以下为操作模板。真实密钥存放、认证配置和启用应先得到用户授权。本次实现未修改 `.env` 或真实凭据。

### Docker（推荐）

容器必须运行在微信所在的 Mac 上，Docker Desktop 需要处于运行状态，并能访问指定的微信账号目录。只挂载一个账号的 `db_storage`，不挂载整个 Library。容器不监听端口，默认通过 `http://host.docker.internal:3000` 访问本机网站的接收接口；其他站点使用 HTTPS 接收地址。主站、模型 worker 和采集器各自运行。

首次设置以下非秘密配置；`INGEST_TOKEN` 使用现有站点配置，由项目根 `.env` 或已授权的进程环境提供。独立 Compose 只把接收 Token 传给采集器，不传模型或数据库凭据。不要将密钥或 Token 写入镜像、构建参数或命令行参数。

```bash
export WECHAT_DB_DIR='/明确账号/db_storage'
export WECHAT_KEY_FILE='/独立私有目录/keys.json'
export WECHAT_ACCOUNT='main'
export WECHAT_LOCAL_ENABLED=true

# 后台持续运行；它会把本机群名同步到管理页，勾选后才读取消息。
npm run docker:wechat
npm run docker:wechat:logs
npm run docker:wechat:stop
```

采集器启动后会定期同步本机群目录（群 ID 和显示名，不包含消息正文）到后台 `/admin/wechat`。在“本机发现的群”里勾选后，采集器才读取该群的消息；取消勾选会停止后续采集并保留已有记录。后台不需要重建容器或编辑群 ID。新选群首次仍默认回填最近 7 天，可用 `WECHAT_SINCE` 调整。

npm 命令自动识别当前 Mac 用户的 UID/GID，避免为容器放宽源文件权限。直接使用 `docker compose` 时需自行提供 `WECHAT_COLLECTOR_UID` 和 `WECHAT_COLLECTOR_GID`，也可显式覆盖这两个值。源 DB 和 key-map 均为只读 bind mount，路径不存在时直接报错，不自动创建假目录。Docker Desktop 文件访问授权属于一次性环境准备，不修改微信。

上述 `export` 适用于当前终端。完成真实配置授权后，可把这些已确认的非秘密配置保存在项目根 `.env`，以后直接运行 npm 命令；现有 `INGEST_TOKEN` 保留。`WECHAT_LOCAL_ENABLED` 只启用采集器自身的两个采集安全阀，不需要改动主站的 `COLLECT_ENABLED`。容器创建后已保存运行环境，Docker Desktop 重启时沿用它。

`WECHAT_SINCE` 可指定首次接入起点，`WECHAT_INTERVAL` 可调整间隔（秒，最低 60）。`SHIPRADAR_INGEST_URL` 指定接收站点。配置改变后重新执行 `npm run docker:wechat` 重建服务；Compose 将新环境应用到容器。Docker Desktop 尚未运行、Mac 睡眠或微信没有更新本地库时，容器无法获取新消息。

去重状态保存于该 Compose 项目的 `state` 卷，加密工作副本使用 `snapshots` 卷。重新创建容器保留状态。更换账号、白名单或接入起点时使用新的 Compose 项目名（`docker compose -p 新名称 -f compose.wechat.yml …`），避免复用不匹配的状态。不要用 `down -v` 清理仍需保留的采集进度。

### 全部本地历史回填

常规采集默认回填近 7 天；如需后台已选择群的全部本地历史，构建包含历史功能的采集镜像后执行：

```bash
npm run docker:wechat:history
```

该命令使用同一账号的只读数据库和独立 `/state/private/history-state.json`，不修改常规采集进度。按时间和本地 ID 每批最多 250 行流式读取，每个消息分片只复制一次；批次上传成功后原子保存游标。中断或接口失败后重跑同一命令，从已成功上传的断点继续；重复上报由服务端幂等处理。传输节流遵守现有接收接口限制，429 按服务端提示等待重试。

进度日志只输出累计上传条数、待处理数和已扫描表数，不输出正文、群 ID 或凭据。累计上传条数包含已在站点存在的近七天消息，最终去重数量以后台各群消息计数为准。`historyComplete=true` 表示已扫描当前所选群的全部现存分片；有未定位撤回时仍显示 `pending` / `incompleteGroups`，不把相关群标记为完整同步。

历史读取仍仅支持文字、链接/卡片及可定位撤回，不转写图片、语音或视频；本机已删除或未保留的消息无法恢复。旧链接卡片允许最多 4 MiB 的原始压缩解码数据，再提取可见文字，最终消息仍保留接收接口的大小限制。回填本身不调用模型，摘要开关不会被该命令开启。

改变历史任务选群范围、账号或接收地址时需指定新的独立历史状态文件，不覆盖原进度。已完成任务重跑只显示完成结果；当前新增消息仍由常规采集器同步。

### 直接运行脚本

```bash
# 仅列出指定账号的群 ID 和显示名，不读消息正文。
WECHAT_LOCAL_ENABLED=true COLLECT_ENABLED=true node scripts/wechat-collect.ts \
  --db-dir /明确账号/db_storage \
  --key-file /独立私有目录/keys.json --list-groups

# INGEST_TOKEN 从已配置的进程环境提供，与 API 接收端一致。
# 接收端默认 http://127.0.0.1:3001；其他地址使用 SHIPRADAR_INGEST_URL。
WECHAT_LOCAL_ENABLED=true COLLECT_ENABLED=true node scripts/wechat-collect.ts \
  --db-dir /明确账号/db_storage \
  --key-file /独立私有目录/keys.json \
  --group 123@chatroom --account main \
  --state /独立私有目录/collector-state.json --once
```

去掉 `--once` 持续运行，默认每 600 秒一轮，`--interval` 最低 60 秒。首次默认近 7 天；用 `--since 2026-10-07T00:00:00+08:00` 明确接入起点。已有状态不会随着日期推进而缩窄范围。群白名单、账号、接收地址或接入起点变化时使用新的状态文件，避免复用错误进度。

状态只保存源账号路径身份、消息 ID 映射和内容 hash，不保存消息正文或密钥。正常消息批次和可确认的 checkpoint 成功后才原子更新状态；存在未定位撤回的群不更新 checkpoint，下一轮继续重查。失败后重试重复消息由接收端幂等处理。后台暂停群时采集器暂停整组白名单，不推进状态；恢复后重查原范围。

`.lock` 文件承载操作系统进程锁，文件本身一直保留；当前采集器结束或被强杀时，锁自动释放，不需要删除文件。另一个采集器不能同时写同一状态。升级前须先停止旧版使用 `.running` 文件的采集进程。不得把一个账号别名同时用于另一个数据目录；每个微信账号用独立 `--account`。

## 摘要和信息流

群选择界面需要应用 `database/migrations/0044_wechat_group_catalog.sql`；摘要使用 `database/migrations/0043_wechat_digests.sql`。2026-10-12 已只读确认本机 Docker 主站库存在这两张表，本轮没有运行迁移；其他部署需分别核对。授权和实际接通状态见 [实施计划](plans/wechat-digest-integration.md)。在表未创建时，群聊管理页会提示完成迁移，worker 不调用摘要模型。

完成经批准的迁移后，在 worker 进程显式设置 `WECHAT_SUMMARIES_ENABLED=true`，同时需要已有模型配置和 `MODEL_CALLS_ENABLED=true`，并显式配置 `WECHAT_SUMMARY_GROUPS=账号:群ID,账号:群ID` 白名单；白名单为空不调用模型。这一步会把选定群的消息内容发送给已配置的模型供应商并产生费用：输入使用匿名发言者代号，遮盖常见手机号、邮箱、证件和长号码，但正则脱敏不是全部隐私的保证。摘要只在 worker 后台生成，打开页面不会调用模型。

- 按群和北京时间日期提炼核心要点；长讨论完整分段后逐层合并，最多 8 个要点，不为空凑数。
- 每条要点必须引用本批输入中的消息 ID；区分个人观点、转述、条件和分歧。
- 沿用既有模型回执与预算，相同输入复用回执。每 30 分钟检查今天与昨天的变更，每轮最多处理 12 个群日，失败冷却 30 分钟后重试；不会扫描或生成更早的历史日期。无变化且已完成的摘要不重复生成。
- 新增消息保留上一版摘要及其生成时间；消息修改/撤回会在同一事务中清除对应旧摘要；各类变更均递增版本。模型期间若原消息被修改/撤回，旧结果不能发布。仅新增消息时，核验后可发布本轮快照，下一轮补齐新增部分。
- 摘要过程最多 100 个输入分段，超过时明确失败，不静默丢弃后面的消息。大量历史回填需要先评估模型费用与处理规模。
- `/wechat` 为私人群聊信息流，可从“今日发现”的“群聊要点”入口进入；详情展开原消息依据。未登录跳转后台登录，HTML 和数据响应均禁止缓存。
- `/admin/wechat` 可从本机同步的群目录选择接入群、停止接收，并查看原消息；只显示稳定发送者身份/联系人显示名，不把无法识别的发送者猜成“我”。群目录同步群 ID 和显示名，不包含消息正文；消息只从已选群读取。

## 验证

无需真实微信、密钥、数据库或外部模型的测试：

```bash
python3 -B -m unittest discover -s scripts/wechat -p 'test_*.py' -v
COLLECT_ENABLED=false MODEL_CALLS_ENABLED=false node --test \
  tests/wechat-local.test.ts tests/wechat-digest-content.test.ts tests/wechat-access.test.ts
npm run typecheck
npm run build -w @aihot/web
node --test apps/web/tests/*.test.ts
```

Python 测试生成真实 SQLCipher 加密夹具和 WAL，不读取真实账号。Web 测试只连接本机合成服务。数据库集成与真实群验收状态以实施计划为准，不能用这些测试代替真实接通。

迁移完成后的数据库专项测试：

```bash
DATABASE_URL=postgres://测试连接/独立_test库 COLLECT_ENABLED=false MODEL_CALLS_ENABLED=false \
  node --test --test-concurrency=1 tests/wechat-store.test.ts tests/wechat-digests.test.ts
```

其中完整链路测试自动生成加密夹具，仅对 localhost 模拟模型临时开启调用，通过生产 `chatJson`/回执路径验证结果落库和重复输入复用，之后恢复测试开关。

Docker 专项（显式运行；测试宿主 Python 需 3.14 生成压缩夹具）：

```bash
docker build -f Dockerfile.wechat -t shipradar-wechat-collector:local .
node scripts/wechat/docker-test.ts
```

该检查使用当前仓库自建的加密合成 DB/WAL 和 Token，绕过项目真实 `.env`，仅连接本机模拟接收服务。覆盖 Mac 加密库在 Linux 容器中的读取、Python 3.13/libzstd 解码、白名单上传、只读挂载、容器重建去重与强杀恢复。每轮使用唯一的 `wechat-docker-test-` 项目，并在结束时清理该轮自身的容器、卷和网络；不删除其他项目或宿主文件。清理失败时明确报告保留的测试项目名。
