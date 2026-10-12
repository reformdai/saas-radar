# Docker 统一启动与配置读取

## 目标与验收

- 主人要求 API、web、worker 用一条命令启动，继续使用 `.env` 中的配置。
- 复用已有 Dockerfile / Compose，不把三个长期进程塞进同一个容器。
- 前端容器只取得页面地址、API 地址和代理开关；服务商密钥、数据库连接仅传给后端角色。
- 文档明确容器内地址覆盖、配置更新、数据持久化及现有本机数据库的切换条件。
- 验证 Compose 解析、镜像构建及运行依赖；不修改真实 `.env`，不执行数据库迁移，不切换当前运行服务。

## 已发现

- 已有 `docker-compose.yml` 启动 db、setup、api、worker、web；setup 自动迁移和种子导入。
- 所有角色共用 `env_file: .env`，导致前端容器也收到后端密钥；web 实际只需 SITE_URL、API_BASE_URL、TRUST_PROXY 和自身监听配置。
- Compose 中 DATABASE_URL 会覆盖 `.env`，默认指向独立 Docker 数据库。现有本机 `.env` 配置了本机回环数据库；直接使用默认 Compose 不会沿用现有文章/设置。
- `.env` 修改后需要重建容器环境；`restart` 不重新注入配置。后台信源、预算及模型选择存储在数据库，沿用数据库才会保留。
- 2026-10-04 向主人询问沿用现有数据库或新建独立库；选择尚待回复。与数据库选择无关的构建和配置检查继续。

## 步骤

1. [x] 读取现有规则、部署、Docker、配置加载实现。
2. [x] 完善 Compose 的前端配置隔离与服务就绪检查。
3. [ ] 根据数据库选择确定启动入口；记录旧数据目录/宿主机网络注意事项。
4. [x] 验证构建与配置加载，不输出真实凭据。
5. [x] 交付默认 Compose 的启动、更新配置、日志和停止命令。实际切换如需迁移、认证配置或停止现有服务，另行明确授权。

## 实施与验证

- `package.json` 增加 docker:up / stop / status / logs / reload；up 等待就绪，reload 仅重建应用容器、不运行 setup。
- `docker-compose.yml` 为 API 与 web 添加 HTTP 健康检查；web 等待 API 健康，只取得六个公开/运行配置项。
- `.dockerignore` 排除任意目录下的 dotenv 与本机 AI 工具目录；实际 `.env` 没有修改。
- README / docs/deploy.md 说明环境变量覆盖、后台设置存储与宿主机数据切换。
- `docker compose config --quiet` 通过；解析后的配置断言验证后端连接一致、web 无密钥环境、API 健康依赖及 worker 210 秒停止宽限。
- Docker 生产镜像构建通过，包含前端生产构建；镜像内 Node 24.21.0、后端和 sharp 原生依赖加载成功，真实 `.env` 与 DAJIALA_KEY 不在镜像。
- 镜像内现有前端测试 34/34 通过（网络禁用、外部服务安全阀关闭）；项目 `npm run typecheck` 通过；`git diff --check` 通过。
- 未启动完整 Compose、未访问现有数据库内容、未运行迁移/后端数据库测试或真实站点 smoke。数据库选择仍待主人回复，不能将构建通过称为已完成当前机器服务切换。

## 当前边界

群聊桥已有未提交改动，保持原状。本任务不配置公众号付费 Key、不启用采集或模型调用、不修改 CI/生产环境、不提交或推送。

## 主人实际启动后的检查

2026-10-04 主人自行执行 `npm run docker:up`，默认 Compose 已创建独立的 `aihot_db` 卷并完成 setup（退出码 0）。原 `saas-radar-local-20261003` 数据库不因本次启动自动迁入新库。

只读检查发现 API 和 worker 持续重启，启动校验报 `IMG_PROXY_SIGN_SECRET` 不合要求；web 因等待 API 健康停在 Created。这不是正常就绪状态。不得绕过生产密钥校验；待主人授权后补齐真实 `.env` 中该密钥，再仅重建三个应用容器，不重复迁移。此次仅查看状态与日志，未修改真实凭据、重启服务或操作数据库。

### 授权修复

主人明确同意补齐随机密钥并重建三个应用容器。确认该项确实缺失后，使用 `crypto.randomBytes(32)` 生成密钥写入真实 `.env`；写入前校验 dotenv 解析并确认其他配置项未改变，不打印密钥、不提交配置。

执行 `npm run docker:reload` 成功，API/web 健康、worker 日志确认启动，db 与 setup 未重建。宿主机 `http://localhost:3000/api/health` 返回 `ok: true, db: ok`。当前仍使用主人新建的独立 Docker 数据库，未迁移旧库。

首次内部 smoke 使用 `http://web:3000`，30 个页面/出口通过，但 MCP 按 Host 白名单正常拒绝内部 `web` 主机名。改用容器内 `http://localhost:3000` 验证，不扩大白名单或修改认证配置。

最终 localhost smoke 全部 31 项通过，包括网站页面、公开 API、RSS、静态资源与 MCP 握手。修复已完成，无新增迁移、无旧库数据移动。
