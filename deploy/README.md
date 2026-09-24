# 自托管部署骨架

Compose 同时启动 Caddy、Quorum TypeScript 后端和 PostgreSQL。PostgreSQL 没有主机端口映射；只有 Caddy 暴露 80/443。应用启动前会执行带校验和的 migration，并为未初始化实例生成一次性 bootstrap secret。

从全新腾讯云 Ubuntu Server 主机开始部署时，按 [`docs/self-hosted/DEPLOYMENT_RUNBOOK.md`](../docs/self-hosted/DEPLOYMENT_RUNBOOK.md) 完成主机加固、Docker 安装、DNS/TLS、首次管理员、业务、持久性和恢复验收。

## 发布镜像

把已通过 `Integration Tests` 的提交合入 `master` 后，先把发布工作流所在提交推送到 GitHub，再为该提交创建形如 `v1.0.0` 的 GitHub Release。`Publish release images` 会重新运行前端、服务端、PostgreSQL 和镜像启动检查，再将检查过的 `linux/amd64` 应用与 Caddy 镜像发布到 `ghcr.io/<仓库所有者>/quorum-app` 和 `ghcr.io/<仓库所有者>/quorum-caddy`。工作流只在发布步骤使用 GitHub 自动提供的短期令牌；不需要把个人令牌写进仓库、工作流或聊天。

工作流成功后，从该次 GitHub Actions 运行摘要复制两条带 `@sha256:` 的完整镜像地址。当前 `v1.0.0` 的应用与 Caddy 镜像均为公开包，生产服务器可匿名拉取。`deploy/compose.production.yaml` 是独立的生产配置，固定这两张镜像和 PostgreSQL 16 镜像的内容哈希，并包含全部端口、健康检查和命名卷设置；服务器不需要仓库源码或 `deploy/compose.yaml`。Compose 项目标识为小写 `quorum`。

发布镜像后，再更新生产 Compose 中的镜像哈希、版本、发布提交编号和 `deploy/.env.production.example`。`Integration Tests` 会核对发布标签仍指向该提交，把生产 Compose 的运行设置与该提交中的 `deploy/compose.yaml` 对比，并确认固定镜像可拉取、适用于 `linux/amd64`；当前开发版 Compose 后续变化不会要求立即改动生产文件。更新生产配置的提交须通过这项检查后再传送到服务器。

在开发机把 `deploy/compose.production.yaml` 和 `deploy/.env.production.example` 复制到服务器的 `/opt/quorum/deploy/`。真正的 `deploy/.env` 只在服务器创建，不能提交到 Git、放进镜像或从开发机传输。保留所用配置文件的 SHA-256 校验值和三张镜像地址，供日后核对。首次启动前检查展开结果，不要打印含密码的完整配置：

```sh
# 在开发机执行；先按部署手册在服务器创建 /opt/quorum/deploy/
sha256sum deploy/compose.production.yaml deploy/.env.production.example
scp deploy/compose.production.yaml deploy/.env.production.example \
  <运维账号>@<服务器IP>:/opt/quorum/deploy/
```

在服务器执行：

```sh
cd /opt/quorum
umask 077
cp deploy/.env.production.example deploy/.env
# 在服务器编辑 deploy/.env 中的域名、数据库密码和 storage master key
docker compose -p quorum --env-file deploy/.env \
  -f deploy/compose.production.yaml config --images
docker compose -p quorum --env-file deploy/.env \
  -f deploy/compose.production.yaml config --quiet
docker compose -p quorum --env-file deploy/.env \
  -f deploy/compose.production.yaml pull
docker compose -p quorum --env-file deploy/.env \
  -f deploy/compose.production.yaml up -d --no-build --wait
```

## 本地源码构建

```sh
cp deploy/.env.example deploy/.env
# 编辑域名、同源 Origin、数据库密码和存储 master key
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

`QUORUM_STORAGE_MASTER_KEY` 必须是 32 字节的无填充 base64url。可用 `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` 生成并单独安全保存。更换 key 时先迁移已有 S3 凭据并递增 `QUORUM_STORAGE_MASTER_KEY_VERSION`；直接替换会使现有密文无法解密。

Caddy 将 `/api/v1/*`、`/health/*` 和 `/metrics` 反向代理到应用，其余未知路径回退到 `index.html`。`/health/live` 只检查进程，`/health/ready` 检查 PostgreSQL migration、持久文件卷可读写性和容量采样；`/metrics` 只公开聚合存储指标。

`QUORUM_STORAGE_WARNING_PERCENT` 与 `QUORUM_STORAGE_CRITICAL_PERCENT` 默认是 80 和 90。critical 只阻止新的上传字节和 provider copy；下载、议事及后台清理保持可用。阈值不能代替宿主机容量告警，仍应监控命名卷所在文件系统。

`QUORUM_PUBLISHED_CACHE_HARD_MAX_BYTES`、`QUORUM_PENDING_REVIEW_HARD_MAX_BYTES`、`QUORUM_PENDING_REVIEW_COMMITTEE_HARD_MAX_BYTES`、`QUORUM_STORAGE_HARD_MIN_FREE_BYTES` 和 `QUORUM_STORAGE_HARD_MIN_FREE_PERCENT` 是管理员页面无法突破的部署硬边界，不提高 app 容器内存上限。

`QUORUM_ALLOWED_ORIGINS` 必须与浏览器实际 HTTPS Origin 完全一致。首次启动的 bootstrap secret 只在应用控制台显示一次；初始化成功后数据库哈希被清除。

本地测试数据库只绑定 `127.0.0.1:55432`，数据放在 tmpfs：

```sh
pnpm self-host:test-db:up
pnpm test:self-host:integration
pnpm self-host:test-db:down
```

`pnpm self-host:test-db:reset` 只删除 `quorum-test-db` Compose 项目的测试数据后重建，不触碰生产 Compose 卷。
