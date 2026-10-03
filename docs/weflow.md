# WeFlow 群聊接入

当前阶段接收和查看白名单群聊，不做 AI 分析，也不进入公开文章、RSS、MCP 或热点。后台入口为 `/admin/wechat`。

## 前提

1. 私人群聊表已在本机 `saas_radar_preview` / `saas_radar_test` 库完成 `0042_wechat_private.sql` 迁移。其他环境需先按授权执行迁移；未迁移时后台会显示“接入准备中”。
2. aihot API、网页服务已运行；配置现有 `INGEST_TOKEN`（至少 16 位）。修改 .env 或认证配置必须获得主人授权。
3. Mac 上的 WeFlow 已连接正确微信账号，并在设置中启用 API 服务、主动推送。默认 `http://127.0.0.1:5031`。

### 本机 PostgreSQL

当前数据库由独立 Docker 容器 `saas-radar-local-20261003` 提供，镜像 `postgres:17-alpine`，端口映射 `127.0.0.1:55432 → 5432`。网站使用 `saas_radar_preview`，测试使用 `saas_radar_test`，不是默认 5432 端口，也不是 `docker-compose.yml` 中的 `db` 服务。

查看与启动现有容器：

```bash
docker ps -a --filter name=saas-radar-local-20261003
docker start saas-radar-local-20261003
```

容器当前重启策略为 `no`，没有配置自动启动。本次迁移没有更改其启动策略或数据库连接配置。

采集桥运行在安装微信/WeFlow 的 Mac 上，aihot 可以在本机或服务器。服务器不需要也不会收到 WeFlow Token。非本机接收地址必须使用 HTTPS，不跟随重定向。

## 启动采集桥

Node 版本与项目要求一致：24.11 以上。复用项目依赖，无新增依赖或全局安装。

在终端进程环境提供 `WEFLOW_TOKEN`（WeFlow 设置中的 API Token）、`INGEST_TOKEN`（与 aihot 一致）和 `AIHOT_BRIDGE_URL`（API 地址，例如本机 `http://127.0.0.1:3001`；部署时用可访问 `/api/ingest/wechat` 的 HTTPS 网站地址）。不要把 Token 写进命令行参数、聊天、截图或 Git。

先列出可选群，输出仅包含群名与群 ID：

```bash
node scripts/weflow-bridge.ts --list-groups
```

然后指定白名单，每个群使用一次 `--group`：

```bash
node scripts/weflow-bridge.ts --account main --group 123456@chatroom --group 789012@chatroom
```

`123456@chatroom` 是占位示例，替换为上一步实际群 ID。`main` 是该微信账号的本地标记，不是微信 ID；不同微信账号必须用不同标记，避免消息和水位混在一起。

首次默认从启动接入时开始。需要历史时可以给 **尚未接入的新群** 指定起始日期：

```bash
node scripts/weflow-bridge.ts --group 123456@chatroom --since 2026-10-03T00:00:00+08:00
```

已有群始终续用服务器保存的水位，重新运行不会重置水位。只查询本机微信已保存的消息，不保证手机历史完整覆盖。

## 查看与暂停

登录 aihot，后台左侧“微信群聊”查看消息；最新页每 5 秒刷新。每个群显示最后接收与补漏时间，可暂停/恢复接收；暂停不删除历史数据。恢复后从原水位补漏，所以暂停不是永久跳过期间消息。

SSE 接收新消息；每分钟查询固定时间窗口并分页补漏。SSE 重连、失败或重复消息不会推进查询水位。消息 ID 以字符串保存并按账号/群/ID 判重；撤回后只显示撤回标记，不保留正文。

WeFlow SSE 对没有稳定 ID 的事件可能不提供可用身份，此类事件跳过，避免错误合并。图片等目前显示占位文字；不下载附件、读取私聊、开启防撤回或发送微信消息。

`Ctrl+C` 停止采集桥。没有配置开机常驻；Mac 休眠或 WeFlow 退出时接收暂停，恢复后补漏。SSE 不保证撤回事件断线重放；只能补到上游仍可查询的记录。

## 公众号订阅的现有入口

打开 `/admin/sources/new`，类型选“公众号”，采集配置填：

```json
{ "ghid": "gh_实际公众号原始ID", "nickname": "公众号名称" }
```

需要后端已经配置 `DAJIALA_KEY`，并有可用额度和采集预算；它是按请求付费的服务。公众号不支持“预览抓取”，创建后进入详情使用手动抓取，或等待 worker 定时采集。在信源页检查最后成功时间与错误原因。单纯创建信源不代表抓取成功。

若只测试列表/正文采集，模型调用可以保持关闭；页面中文分析结果需要后续模型处理。新号首次导入的存量文章可能按历史归档，不会出现在今日动态。不要为试用而自动启用生产采集或修改现有凭据。
