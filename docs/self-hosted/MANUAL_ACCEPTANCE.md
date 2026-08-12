# 自托管人工验收清单

本文件记录当前环境无法自动执行的验收。自动测试仍应保留并在具备依赖时运行；人工验收不能代替本可自动化的测试。

状态使用：`待执行`、`通过`、`失败` 或 `延期`。执行后保存命令输出、HTTP 响应、容器状态、浏览器截图或资源监控结果，并在对应项目中注明证据位置。

## 阶段 1：后端和部署骨架

当前状态：因开发环境没有 Docker、Caddy、PostgreSQL 或可用服务器，以下项目延期至具备环境后执行。

### SH-MAN-001 全新主机启动

- 前置条件：全新 Ubuntu x86-64 主机、Docker Engine、Compose 插件、域名和环境文件。
- 步骤：仅复制仓库和 `deploy/.env`，执行 `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build`。
- 通过条件：Caddy、应用和 PostgreSQL 均进入健康状态；无需在主机额外安装 Node.js、pnpm、Caddy 或 PostgreSQL。
- 证据：Compose 构建输出、`docker compose ps` 和容器健康状态。
- 状态：延期。

### SH-MAN-002 PostgreSQL 网络隔离

- 前置条件：阶段 1 Compose 已启动，使用另一台可访问该服务器的设备。
- 步骤：检查主机监听端口、Compose 端口映射，并从外部探测 TCP 5432。
- 通过条件：主机只公开预期的 80/443；公网和局域网均不能直接连接 PostgreSQL 5432。
- 证据：`ss -ltnp`、Compose 配置输出和外部端口探测结果。
- 状态：延期。

### SH-MAN-003 空库 migration 与重复启动

- 前置条件：可创建和删除隔离 PostgreSQL 数据卷。
- 步骤：从空卷启动；记录 migration；重启应用两次；再次检查 migration 表和 readiness。
- 通过条件：空库成功应用全部 migration；重复启动不重复执行或修改已应用记录；校验和一致；`/health/ready` 保持 200。
- 证据：应用日志、`quorum_meta.schema_migrations` 查询结果和两次 readiness 响应。
- 状态：延期。

### SH-MAN-004 Caddy 路由和 SPA fallback

- 前置条件：Compose 已启动，域名或本地测试地址可访问。
- 步骤：访问 `/api/v1/version`、`/health/live`、`/health/ready`、`/` 和一个有效的 React 深层路由；刷新深层路由。
- 通过条件：API 和健康路径由应用响应；静态资源由 Caddy 返回；深层路由及刷新均返回 SPA，不出现 Caddy 404。
- 证据：HTTP 状态、响应头、响应正文和浏览器截图。
- 状态：延期。

### SH-MAN-005 健康检查语义

- 前置条件：Compose 正常运行，并可分别停止数据库或使存储卷不可写。
- 步骤：在正常状态、数据库不可用和存储不可写三种条件下调用两个健康接口。
- 通过条件：进程存活时 `/health/live` 返回 200；数据库或必要存储不可用时 `/health/ready` 返回统一的 503 错误格式；响应均包含 request ID，且不泄露内部错误。
- 证据：三种状态下的 HTTP 响应及对应结构化日志。
- 状态：延期。

### SH-MAN-006 持久卷重启

- 前置条件：Compose 已启动，并已在数据库和文件卷写入可识别测试数据。
- 步骤：执行普通 Compose 重启和容器重建，不删除命名卷；重新读取测试数据。
- 通过条件：数据库 migration 记录和文件卷内容均保留；应用恢复 readiness。
- 证据：重启前后查询结果、文件哈希和容器状态。
- 状态：延期。

### SH-MAN-007 2 GiB 内存基线

- 前置条件：2 核、2 GiB 内存、40 GiB SSD 的目标级 Ubuntu 主机。
- 步骤：启动完整 Compose，连续运行至少 30 分钟；重复请求 SPA、版本和健康接口；记录容器内存、重启次数和 OOM 状态。
- 通过条件：全部服务稳定运行，无 OOM、崩溃或重启循环；总内存占用不超过主机可用内存并保留操作系统余量；健康检查持续通过。
- 证据：`docker stats`、`docker inspect`、系统内存数据和 30 分钟后的健康响应。
- 状态：延期。

## 后续阶段

每个阶段实现时继续追加测试项目。已经可以由自动测试稳定覆盖的项目应保留自动测试，并从人工清单中删除重复步骤或注明人工部分仅验证真实部署边界。
