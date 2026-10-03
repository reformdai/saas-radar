# WeFlow SSE 群聊接入

目标：在 aihot 私人后台接收白名单群聊、按群查看原消息，通过 SSE 低延迟接收并用查询 API 补漏。公众号主题发现与评论不在本次范围。

## 边界

- Mac 上运行单独采集桥，连接本机 WeFlow；通过现有 INGEST_TOKEN 向 aihot 的独立私人接口上报。WeFlow Token 不传到服务器。
- 私聊和未选择的群不保存、不上报。不进入文章库、公开页面、RSS、MCP、热点和模型处理。
- 使用现有后台会话与 CSRF；普通访客不能读消息。保留暂停群的能力，不提供删除。
- 不改 .env、已有密钥、系统配置或生产部署。数据库迁移已获主人本次明确授权，仅执行本地库；不提交其他工具留下的改动。

## 涉及文件

- packages/contracts/src/wechat.ts：私人接入契约。
- packages/backend/src/wechat/bridge.ts：SSE 解析、白名单、分页补漏、重连。
- packages/backend/src/wechat/store.ts：私有数据读写。
- apps/api/src/routes/ingest.ts、admin.ts：复用现有鉴权，添加私人写入与读取入口。
- scripts/weflow-bridge.ts：Mac 采集桥命令入口。
- apps/web/app/routes/admin/wechat.tsx 及后台导航：群聊查看与暂停。
- docs/weflow.md、tests/weflow-bridge.test.ts：运行说明和验证。
- apps/web/app/routes/admin/source-new.tsx：修正公众号默认配置字段。

## 数据设计（已授权并完成本地迁移）

新增 wechat_groups：account + group_id 联合主键；name、enabled、reconcile_through、last_received_at、last_checked_at。

新增 wechat_messages：account + group_id + message_id 联合主键；sender_id、sender_name、content、sent_at、revoked、received_at；外键指向群；按群与 sent_at/message_id 索引。

消息主键保持字符串，避免 64 位微信 ID 在 JavaScript Number 中丢精度。撤回保存无正文的墓碑，迟到的原消息不能恢复正文。SSE 不推进补漏水位；只有一个完整固定时间窗口全部分页成功后才推进。

## 进度

2026-10-03 下午：主人明确要求完成数据库迁移，已授权新增私有表及本地迁移。确认目标为 Docker 容器 `saas-radar-local-20261003` 的 PostgreSQL 17（127.0.0.1:55432）；网站库 `saas_radar_preview`，独立测试库 `saas_radar_test`。两个库均已应用截至 0041 的旧迁移，本次只增加 0042。先验证测试库，再应用网站库；不修改 .env 或容器配置。

- [x] 读取规则、确认 dirty worktree、核对本地 WeFlow SSE 源码与文档。
- [x] 确认公众号订阅入口：/admin/sources/new，类型 mp_account。
- [x] 完成桥、私人 API 和后台页面。
- [x] 模拟 SSE/查询 API、访问鉴权与架构验证：15 项通过；类型检查通过。
- [x] 前端构建通过；群聊页面真实生产 SSR 3 项通过；既有前端测试 31 项通过。
- [x] 主人批准新增私有表；0042 已在测试库验证并应用至本地网站库，重复执行返回 database is up to date。
- [x] 独立测试库验证入库去重、64 位消息 ID、单调水位、两种撤回顺序、暂停/恢复、账号隔离、外键与撤回正文约束；含桥/API/架构共 17 项测试通过。
- [x] 实际网站库读取返回 ready=true，尚无群和消息；未向网站库写入模拟消息。
- [x] 迁移后类型检查、web 构建、34 项前端测试、31 项运行站点冒烟检查、git diff --check 通过。匿名后台 HTTP 返回 401，未为验收更改登录配置。
- [ ] 配置真实连接并验收（WeFlow 与本机 aihot 默认端口当前不可达）。

## 验收

分段 SSE 和多行 data 可解析；私聊、未选择群、非法或缺失 ID 不入库；失败不推进水位；固定窗口分页完整；重复上报幂等；撤回不恢复；暂停不接收；匿名读取与缺失 CSRF 被拒绝；关闭桥时连接退出。不调用外部模型或付费采集。

首次接入默认只补接入启动以后的消息，可用 --since 明确选择历史起点。真实微信版本的撤回重放能力不保证，断线补漏只能恢复上游仍可查询的记录。

## 建表结构

以下结构已落入 `database/migrations/0042_wechat_private.sql`，按现有迁移体系执行；不修改任何旧表。

```sql
CREATE TABLE wechat_groups (
  account text NOT NULL,
  group_id text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  reconcile_through bigint NOT NULL CHECK (reconcile_through > 0),
  last_received_at timestamptz,
  last_checked_at timestamptz,
  PRIMARY KEY (account, group_id),
  CHECK (group_id LIKE '%@chatroom')
);
CREATE TABLE wechat_messages (
  account text NOT NULL,
  group_id text NOT NULL,
  message_id text NOT NULL,
  sender_id text NOT NULL DEFAULT '',
  sender_name text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  sent_at bigint NOT NULL CHECK (sent_at > 0),
  revoked boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, group_id, message_id),
  FOREIGN KEY (account, group_id) REFERENCES wechat_groups (account, group_id),
  CHECK (NOT revoked OR content = '')
);
CREATE INDEX wechat_messages_group_time ON wechat_messages (account, group_id, sent_at DESC, message_id DESC);
```

epoch 列使用 bigint，读取时转换为 float8（本接口时间范围内是精确整数），保证 API 输出 number。微信消息 ID 始终使用 text，不转换为浮点数。

## 本次交付状态

代码、本地数据库迁移及群聊数据库行为验证已完成，尚不能宣称真实微信已打通。真实 WeFlow Token、接收服务 INGEST_TOKEN 与白名单群由主人确认并配置，不在本次输出。

运行环境：当前 Node v24.9.0，低于项目声明的 24.11，但上述检查实际通过；未升级 Node 或安装全局依赖。真实部署沿用项目要求。未提交、推送、重启生产或覆盖任务开始前的改动。

剩余验收：配置真实连接和群白名单 → 连续新消息与断线恢复验收。生产部署另需明确授权。

## macOS 4.1.15 接入阻塞诊断

2026-10-03：主人截图显示 `SCAN_FAILED: Sink pattern not found`，阻塞在 WeFlow 密钥获取阶段，尚未到 SSE。只读确认微信 4.1.15；当前 WeFlow 进程来自 `WeFlow/release/mac-arm64/WeFlow.app`，版本 4.3.0，本地源码最后提交 2026-05-10。源码资源里的 xkey_helper 与运行包里的 helper SHA256 不同，且源码的四个 macOS helper 文件已有 dirty 修改；未覆盖，尚不清楚这些改动是否适配 4.1.15。

上游 main 的 package.json 当前为 5.0.0，README / docs/third-party-components.md 已声明不再内置原生读取/解密组件，Releases 页面当前没有版本。故不能把最近仓库更新等同于当前微信兼容性修复，未找到官方 4.1.15 适配证据。官方 issue #1131 记录的是 4.1.11 相同 sink 定位错误及社区补丁，不是 4.1.15 验证结果。

本地旧版 UI 调用 xkey_helper 子进程；直接 CLI 使用相同 helper 不会自动修复特征匹配。可独立获取有效密钥后在 WeFlow 填入，但完整无桌面服务不是当前已验证路径。wechat-digest README 记录已有 per-DB 密钥与解密脚本，可作为另一个候选，需要授权验证其对当前账号数据库是否仍有效以及与 WeFlow 密钥格式是否兼容；本次未读取密钥、扫描微信进程、改变 SIP、降级微信或升级 WeFlow。

来源：https://github.com/hicccc77/WeFlow/issues/1131 ；https://github.com/hicccc77/WeFlow/blob/main/docs/third-party-components.md ；https://github.com/hicccc77/WeFlow/blob/main/package.json 。

主人随后授权尝试：仅针对截图所示账号，用已有 per-DB 密钥在内存中做 SQLCipher v4 首页 HMAC 校验。session/contact 均通过；现存 14 个 message DB 的对应已存密钥有 13 个通过（不能视为完整覆盖）。session 密钥不同于 contact 密钥，对这 14 个 message DB 均不适用。随后以 SQLCipher `mode=ro&immutable=1` 实际读取 session/contact 的 sqlite_master 计数，两个库均可读；未读取消息正文或输出密钥，未修改源数据库。

源码 helper 和运行包 helper 的 arm64 `__TEXT,__text` 内容一致；文件哈希差异不足以证明功能有更新，重打包当前 helper 没有代码层面的修复。对隔离的加密 session.db 临时副本执行原生 WCDB 兼容性探针，`wcdb_init` 返回 -1006，未到 open_account 调用；因此不能据此判断 saved session key 是否被 WeFlow 接受，也不能宣称 WeFlow 已接通。未更新 WeFlow、覆盖组件、修改 WeFlow 密钥配置、扫描微信进程或调用外部服务。

完整后端回归另行尝试，未通过且已停止，不作为本次验收通过的依据。复用的 `saas_radar_test` 并非空库（告警测试发现数千条既有测试文章）；运行时保持 MODEL_CALLS_ENABLED=false，而若干分析测试需要本机模型 stub 路径，当前配置在 llm 调用入口禁止该路径。运行出现分析失败及 120 秒超时后停止全量 runner，未修复无关测试或清空测试库。群聊专项 17 项此前独立执行全部通过。本次验证不等于全项目后端回归通过。
