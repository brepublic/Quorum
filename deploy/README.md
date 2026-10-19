# 自托管部署骨架

Compose 同时启动 Caddy、Quorum TypeScript 后端和 PostgreSQL。PostgreSQL 没有主机端口映射；只有 Caddy 暴露 80/443。应用启动前会执行带校验和的 migration，并为未初始化实例生成一次性 bootstrap secret。

从全新腾讯云 Ubuntu Server 主机开始部署时，按 [`docs/self-hosted/DEPLOYMENT_RUNBOOK.md`](../docs/self-hosted/DEPLOYMENT_RUNBOOK.md) 完成主机加固、Docker 安装、DNS/TLS、首次管理员、业务、持久性和恢复验收。

## 发布镜像

把已通过 `Integration Tests` 的提交合入 `master` 后，先把发布工作流所在提交推送到 GitHub，再为该提交创建形如 `v1.0.0` 的 GitHub Release。`Publish release images` 先从同一发布提交构建并验收 Windows EXE 与 Linux AppImage，再运行前端、服务端、PostgreSQL 和镜像启动检查，再将检查过的 `linux/amd64` 应用与 Caddy 镜像发布到 `ghcr.io/<仓库所有者>/quorum-app` 和 `ghcr.io/<仓库所有者>/quorum-caddy`。工作流只在发布步骤使用 GitHub 自动提供的短期令牌；不需要把个人令牌写进仓库、工作流或聊天。

工作流成功后，从该次 GitHub Actions 运行摘要复制两条带 `@sha256:` 的完整镜像地址。当前 `v1.0.0` 的应用与 Caddy 镜像均为公开包，生产服务器可匿名拉取。`deploy/compose.production.yaml` 是独立的生产配置，固定这两张镜像和 PostgreSQL 16 镜像的内容哈希，并包含全部端口、健康检查和命名卷设置；服务器不需要仓库源码或 `deploy/compose.yaml`。Compose 项目标识为小写 `quorum`。

发布镜像后，再更新生产 Compose 中的镜像哈希、版本、发布提交编号和 `deploy/.env.production.example`。`Integration Tests` 会核对发布标签仍指向该提交，把生产 Compose 的运行设置与该提交中的 `deploy/compose.yaml` 对比，并确认固定镜像可拉取、适用于 `linux/amd64`；当前开发版 Compose 后续变化不会要求立即改动生产文件。更新生产配置的提交须通过这项检查后再传送到服务器。

在开发机把 `deploy/compose.production.yaml`、`deploy/.env.production.example` 和 `deploy/upgrade.sh` 复制到服务器的 `/opt/quorum/deploy/`。真正的 `deploy/.env` 只在服务器创建，不能提交到 Git、放进镜像或从开发机传输。保留所用配置文件的 SHA-256 校验值和三张镜像地址，供日后核对。首次启动前检查展开结果，不要打印含密码的完整配置：

```sh
# 在开发机执行；先按部署手册在服务器创建 /opt/quorum/deploy/
sha256sum deploy/compose.production.yaml deploy/.env.production.example deploy/upgrade.sh
scp deploy/compose.production.yaml deploy/.env.production.example deploy/upgrade.sh \
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

## Chair Agent 下载与常规升级

从包含此功能的新发行开始，网站镜像只携带当前配套的 Windows EXE、Linux AppImage、下载清单和校验值。主席在文件存储设置中的“下载主席 Agent”菜单下载；底部链接打开同一个服务器发行标签的 GitHub Release。安装包按公开软件提供下载，不进入委员会文件、审核缓存或数据库。ZIP、解压包和对应源码只上传 GitHub Release，不随服务器镜像携带。

发布工作流先校验两平台的提交、干净源码状态、Agent 版本和所有发行产物的大小／SHA-256。缺少平台、对应源码或校验失败即停止；不使用 `latest`，不从其他工作流的“最近一次成功”选取安装包。前端把同一清单编入页面，Caddy 提供带版本的路径，缺失文件直接返回 404。源码开发构建没有安装包时，菜单显示“此版本暂无安装包”。

更新固定镜像的生产 Compose 后，保留原 `deploy/.env`，在服务器运行：

```sh
cd /opt/quorum
sudo bash deploy/upgrade.sh
```

脚本需要 Bash、Docker Compose、jq、curl、sha256sum、flock。它拉取镜像，核对应用／网站的发布标签和源码提交，校验镜像中的安装包，再启动新容器。HTTPS 就绪、运行版本、下载清单和两份安装包的实际下载哈希全部通过后，才清理此次替换的旧应用／网站镜像；下载校验流式进行，不在服务器另存一份安装包。镜像内的 `QUORUM_BUILD_VERSION` 优先于旧 `.env` 中的显示版本，避免升级后仍报告旧版本。自建 CA 可通过 `CURL_CA_BUNDLE` 指定，使用 sudo 时显式传递该环境变量；不关闭 TLS 验证。

升级期间需暂存新旧两套镜像。拉取失败不会切换容器；切换后的验收失败会保留旧镜像并返回失败，不自动回滚数据库。清理记录位于 `deploy/.upgrade-images`，中断或清理失败后可重跑同一脚本继续验证和清理。其他容器仍使用的旧镜像、有其他仓库引用的镜像不删除，并明确报告清理未完成；不执行全局 prune、不删除数据卷。更早的历史镜像不在自动清理范围内。

直接执行 `docker compose up` 仍会切换网站内的安装包，但不会自动清理旧镜像；需要上述升级入口才完成清理。现有生产 Compose 仍固定已发布版本，本次源码改动不会虚构新镜像哈希；等新发行成功后按前文更新它。旧发行不含下载清单和版本标签，不能使用此脚本作为升级目标。

## 现有实例的北京规则升级

包含 schema 86 的新发布会在应用启动时自动保存已发布规则的不可变历史副本，核对完整定义及原版本 ID 后，移除北京内置包的旧目录版本，仅保留最新已发布版本。活动／暂停委员会、开放／待开始会期和指向旧北京规则的管理员默认值自动切换到最新版；归档委员会、已关闭会期及已创建议事记录继续按原 ID 读取历史副本。账号、登录会话、模板和委员会固定内容保留，自定义规则目录保留。

部署前保存数据库与文件恢复点，按上述发布流程更新生产 Compose 的固定镜像地址，保留服务器已有的 `deploy/.env`、数据库密码和存储密钥，再执行 `pull` 与 `up -d --no-build --wait`。检查 `/health/ready` 和升级日志，确认第 86 次升级已完成，并验证登录、规则选择和现有委员会快照；不需要逐个手动切换规则。已经完成过此升级的实例重启不会重复追加迁移事件。

本次规则升级不处理 schema 56 以前的委员会内容转换；含有这类旧数据的服务器仍会被已有的升级检查阻止，应先单独确认内容迁移方案。历史规则内容保存在 `rule_version_snapshots`，可选目录 `rule_package_versions` 中北京内置包仅保留最新版；不执行开发环境清理脚本。升级失败会整体回滚本次事务并阻止应用就绪，可按升级日志修复后重启。成功升级后若需回退不支持 schema 86 的旧镜像，应按恢复手册同时恢复升级前数据库，不能只回退应用镜像。

## 本地源码构建

```sh
cp deploy/.env.example deploy/.env
# 编辑域名、同源 Origin、数据库密码和存储 master key
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

`QUORUM_STORAGE_MASTER_KEY` 必须是 32 字节的无填充 base64url。可用 `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` 生成并单独安全保存。更换 key 时先迁移已有 S3 凭据并递增 `QUORUM_STORAGE_MASTER_KEY_VERSION`；直接替换会使现有密文无法解密。

Caddy 将 `/api/v1/*`、`/health/*` 和 `/metrics` 反向代理到应用；`/downloads/chair-agent/*` 只提供安装包静态文件，其他未知路径回退到 `index.html`。`/health/live` 只检查进程，`/health/ready` 检查 PostgreSQL migration、持久文件卷可读写性和容量采样；`/metrics` 只公开聚合存储指标。

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
