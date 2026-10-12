# 本地微信群采集器 Docker 化

## 目标与授权

2026-10-07：主人要求将本地采集器部署到 Docker。实现并验证独立 Docker 镜像与 Compose 服务，容器仍运行在微信所在的 Mac；只读挂载指定账号 DB 和 key-map，调用现有消息接收 API。采集器容器重启后继续去重，不依赖 WeFlow 或 wechat-digest。

当前请求授权 Docker 化项目代码、普通项目 Docker 配置及隔离容器验证。真实密钥复制/修改、真实业务库迁移、群白名单选择与生产发布仍按原边界处理；未确认的真实群不自动选定。

## 现状

- 工作区包含前几轮群聊实现、迁移，以及大量公众号相关未提交修改；不覆盖其他改动。
- 现有主站 Compose 使用 `aihot` 项目；采集器使用单独 Compose 文件与项目，不修改现有站点容器/业务配置。
- Node 采集器只运行 `local.ts`，运行时第三方依赖只有已锁定的 zod，Docker 可只带实际用到的代码和依赖。
- Python reader 使用 SQLCipher C API 与 Python 3.14 zstd。Debian trixie 提供 SQLCipher 4 系列，Python 3.13 可使用系统 libzstd 的标准 C API 解压，保持有界输出和显式错误。
- 旧独占创建锁会在强杀后遗留，不能支持 Docker 自动重启；改用 Python 标准库 fcntl 进程锁，文件保留但锁随进程结束释放。

## 步骤与文件

1. `scripts/wechat/reader.py`：发现 Linux/macOS SQLCipher 库，增加系统 libzstd 的有界解压路径。
2. `scripts/wechat/lock.py`、Node 调用适配：操作系统进程锁覆盖采集生命周期，验证同时采集被拒绝、崩溃后自动释放。
3. `Dockerfile.wechat`：Node 24 + Python/SQLCipher/libzstd，复制最小运行代码、现有锁文件中的 zod，不打包真实配置或数据。
4. `compose.wechat.yml` 与入口：显式白名单；源 DB/key-map 只读挂载；持久化状态/加密副本目录；重启策略；无监听端口；默认经 Docker host 地址连接本机站点。
5. 合成夹具 Docker 验证：构建、库版本、压缩正文、只读源、消息上传、重新创建容器后的去重、异常锁释放；验证 Compose 配置。
6. 文档补 Docker 配置与启动命令、所需权限和已验证/未验证边界。

## 验收标准

- 从本仓库构建和运行；运行代码不引用参考项目。
- 容器内真实 SQLCipher 加密 DB/WAL 读取与 zstd 解码通过，源挂载禁止写入。
- 只上传明确白名单群；凭据不进入镜像或日志。
- 状态持久化后重新创建容器不重复上传；强制终止不导致永久锁死。
- 普通启动不会启动/重建主站或迁移业务数据库。
- Docker Desktop 需运行并能访问指定目录；微信数据及逐库密钥仍需一次性配置。真实群验收以此前任务计划为准，不能把夹具通过当真实接通。

## 实现与验证结果

- 独立镜像 `shipradar-wechat-collector:local` 已在本机 arm64 Docker 构建通过。镜像内为 Node 24、Python 3.13、SQLCipher 4.6.1、libzstd；运行时仅带 zod 和当前仓库所需采集代码，没有参考项目、真实配置或数据。
- 新增 `compose.wechat.yml`，只读挂载账号 DB 与 key-map，状态和工作副本使用独立命名卷；只启用自身安全阀，不改变主站采集开关。npm 命令自动带当前宿主用户 UID/GID，默认经 `host.docker.internal:3000` 上传。
- Python 8 项（含 native zstd 与强杀锁释放）通过，Node 9 项（含实际 Node→Python 锁生命周期）通过。类型检查、web 构建、全部 39 项 web 测试通过。
- `node scripts/wechat/docker-test.ts` 最终全部通过：Compose 校验、Mac SQLCipher 加密 DB/WAL 在 Linux 解密、zstd 文字、群白名单、只读挂载拒绝写入、源文件 hash 不变、重新创建容器去重、强杀后新采集器接管、Compose 服务内主进程异常退出后 Docker 自动重启及再次去重。
- 自动恢复测试首轮使用 `docker kill`，容器被 Docker 视为手动停止，不能代表进程崩溃。按 Docker 官方重启策略说明，最终测试改为在成功启动 10 秒后让容器内采集进程异常退出，实测 RestartCount 增加并恢复上传检查。
- Docker 验证只使用当前仓库新建的加密夹具、合成 Token 与 localhost 模拟接收服务，显式不加载真实 `.env`。测试服务在验证结束时停止，已停止容器/卷和临时夹具保留供核对；没有删除用户资源。
- 此轮没有新增数据库变更；沿用上一轮数据库专项与站点 smoke 的通过证据。完整后端回归仍有上一轮记录的模型开关及缺少 pg_dump 问题，本轮未重复运行无关失败策略或修改其检查。

运行命令和一次性配置见 `docs/wechat-local.md`。当前 Docker 能力已实现并验证；真实账号 key-map、真实群白名单与认证配置仍待明确授权/提供，未启动真实群采集或替换当前主站服务。

## 后续 Docker 清理

主人随后明确要求清理 Docker 遗留资源及闲置镜像。上述保留的测试容器、卷和网络已清理，新的采集器镜像保留。Docker 验证脚本已改为每轮唯一项目并自动清理自己的 Docker 资源，实际复跑通过；详情见 `docs/plans/docker-cleanup-20261007.md`。不会在未来测试中默认留下容器/卷。
