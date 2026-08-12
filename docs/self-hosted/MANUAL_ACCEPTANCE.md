# 自托管人工验收清单

本文件按实施阶段记录必须在真实 PostgreSQL、浏览器、TLS、Docker Compose 或目标服务器上完成的验收。状态只使用：`待执行`、`通过`、`失败`、`因无服务器延期`。自动测试不能替代真实部署证据；能稳定自动化的检查仍须保留为代码测试或脚本。

## 阶段 1：后端和部署骨架

当前开发环境未检测到 Docker、Caddy 或 PostgreSQL，且没有可用服务器。以下项目均保留自动化覆盖并延期真实环境验收。

### SH-MAN-001 Compose 从全新环境启动

- 前置条件：全新 Ubuntu x86-64 主机、Docker Engine、Compose 插件、域名和按 `deploy/.env.example` 创建的环境文件。
- 操作步骤：仅复制仓库和环境文件；执行 `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build`；等待健康检查；执行 `docker compose --env-file deploy/.env -f deploy/compose.yaml ps`。
- 通过条件：Caddy、应用和 PostgreSQL 均为运行且健康状态；主机无需另装 Node.js、pnpm、Caddy 或 PostgreSQL。
- 自动化覆盖情况：`server/src/deploy/deployment-config.test.ts` 静态检查服务、健康检查、依赖和内存限制；不能证明镜像可在真实 Docker 主机启动。
- 当前状态：因无服务器延期。
- 需要保存的证据：Compose 构建输出、`docker compose ps`、三个容器的健康状态和应用启动日志。

### SH-MAN-002 PostgreSQL 不暴露公网端口

- 前置条件：阶段 1 Compose 已启动；另有一台能访问服务器公网或局域网地址的设备。
- 操作步骤：检查主机监听端口和 `docker compose config`；从外部设备探测 TCP 5432；确认应用仍能通过内部网络访问数据库。
- 通过条件：主机仅公开预期的 80/443；公网和局域网均不能直接连接 PostgreSQL 5432；应用 readiness 正常。
- 自动化覆盖情况：`server/src/deploy/deployment-config.test.ts` 断言 PostgreSQL 没有 Compose `ports` 映射；不能替代主机监听和外部网络探测。
- 当前状态：因无服务器延期。
- 需要保存的证据：`ss -ltnp`、`docker compose config`、外部端口探测和 readiness 响应。

### SH-MAN-003 空库 migration

- 前置条件：可用 PostgreSQL 16；管理员连接写入 `TEST_DATABASE_ADMIN_URL`，且该账号可创建和删除测试数据库。
- 操作步骤：执行 `TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration`；确认测试创建随机命名的独立数据库、执行 migration 并清理。
- 通过条件：全部 migration 从空库成功执行；测试数据库包含预期表、约束和 schema 版本；测试结束后临时数据库被删除。
- 自动化覆盖情况：`server/src/db/migrations.integration.test.ts` 和阶段 2 身份 PostgreSQL 集成测试连接真实 PostgreSQL；未配置 URL 时明确 skip，不使用内存数据库代替。
- 当前状态：因无服务器延期。
- 需要保存的证据：测试命令输出、migration 日志、临时数据库列表和 `quorum_meta.schema_migrations` 查询结果。

### SH-MAN-004 migration 重复启动安全

- 前置条件：与 SH-MAN-003 相同，或已启动隔离测试 Compose。
- 操作步骤：在同一测试数据库连续运行 migration 两次并重启应用两次；查询 migration 表和 readiness。
- 通过条件：已应用版本不重复执行、不修改应用时间或校验和；两次启动均通过 readiness。
- 自动化覆盖情况：`server/src/db/migrations.integration.test.ts` 对同一真实临时数据库执行两次；真实容器重启仍需人工确认。
- 当前状态：因无服务器延期。
- 需要保存的证据：两次应用日志、migration 表前后查询、两次 readiness 响应和容器重启次数。

### SH-MAN-005 Caddy API、健康检查和 SPA fallback

- 前置条件：Compose 已启动；通过配置的 HTTPS 地址访问实例。
- 操作步骤：访问 `/api/v1/version`、`/health/live`、`/health/ready`、`/` 和一个有效 React 深层路由；刷新深层路由。
- 通过条件：`/api/v1/*` 和 `/health/*` 由应用响应；静态资源由 Caddy 返回；深层路由及刷新均返回 SPA；HTTPS 证书有效。
- 自动化覆盖情况：`server/src/deploy/deployment-config.test.ts` 检查 Caddy handler 顺序和 fallback；不能证明真实代理、TLS 或浏览器刷新行为。
- 当前状态：因无服务器延期。
- 需要保存的证据：HTTP 状态、响应头与正文、Caddy 日志、证书信息和浏览器截图。

### SH-MAN-006 `/health/live`、`/health/ready` 和 `/api/v1/version`

- 前置条件：Compose 正常运行，并可暂时停止数据库或令文件卷不可写。
- 操作步骤：在正常、数据库不可用、存储不可写三种状态下调用健康接口；调用版本接口；恢复依赖后再次检查。
- 通过条件：进程存活时 live 为 200；必要依赖不可用时 ready 为统一 503 envelope；版本接口返回契约、规则和 migration 版本；所有响应含 request ID 且不泄露内部错误。
- 自动化覆盖情况：`server/src/http/app.test.ts` 覆盖 envelope、request ID、版本和失败隐藏；真实依赖故障及跨容器恢复需人工执行。
- 当前状态：因无服务器延期。
- 需要保存的证据：各状态的 HTTP 响应、结构化日志、依赖停止与恢复命令。

### SH-MAN-007 持久卷重启后保留

- 前置条件：Compose 已启动；数据库和文件卷已写入可识别测试数据。
- 操作步骤：记录数据库行和文件 SHA-256；执行普通重启和不删除命名卷的容器重建；重新读取数据。
- 通过条件：migration、身份数据和文件均保留；文件哈希不变；应用恢复 readiness。
- 自动化覆盖情况：静态部署测试检查命名卷挂载；没有自动测试可证明 Docker 卷重建后的真实持久性。
- 当前状态：因无服务器延期。
- 需要保存的证据：重启前后数据库查询、文件哈希、`docker volume ls`、Compose 状态和 readiness。

### SH-MAN-008 2 核、2 GiB 稳定启动和内存占用

- 前置条件：2 核、2 GiB 内存、40 GiB SSD 的 Ubuntu x86-64 目标主机。
- 操作步骤：启动完整 Compose；连续运行至少 30 分钟；重复请求 SPA、版本和健康接口；记录容器内存、重启次数、OOM 与系统余量。
- 通过条件：服务无 OOM、崩溃或重启循环；总占用不超过可用内存并保留操作系统余量；健康检查持续通过。
- 自动化覆盖情况：静态部署测试检查 Compose 内存上限；不能替代目标硬件的运行与容量测量。
- 当前状态：因无服务器延期。
- 需要保存的证据：`docker stats`、`docker inspect`、`free -h`、内核 OOM 日志和 30 分钟后的健康响应。

## 阶段 2：身份和唯一系统管理员

### SH-MAN-101 真实 TLS Cookie 和跨请求 Session

- 前置条件：通过 Caddy HTTPS 访问已完成 migration 的实例；使用全新浏览器配置文件。
- 操作步骤：使用 bootstrap secret 初始化；检查 `Set-Cookie`；刷新页面并在多个请求中调用 `/api/v1/auth/me`；执行登录、密码确认提权和改密并比较 Session ID；退出后重放旧 Cookie。
- 通过条件：Session Cookie 具有 `Secure`、`HttpOnly`、`SameSite=Lax`；刷新后身份保持；登录、提权和改密均轮换 Session ID；退出及撤销后旧 Cookie 立即返回统一 401。
- 自动化覆盖情况：HTTP 测试检查 Cookie 字符串和 handler 行为；真实浏览器 Cookie jar、TLS 与跨请求行为必须人工验证。
- 当前状态：因无服务器延期。
- 需要保存的证据：脱敏 HTTP 响应头、浏览器存储截图、退出前后响应；不得保存完整 Session 或 CSRF token。

### SH-MAN-102 浏览器 Origin 与 CSRF

- 前置条件：HTTPS 实例、已登录账号、可从允许和不允许的两个 Origin 发起测试请求。
- 操作步骤：分别提交正确 token、缺失 token、错误 token和非允许 Origin 的写请求；检查浏览器控制台和服务器日志。
- 通过条件：只有允许 Origin 且 CSRF token 正确的请求成功；其他请求返回统一 403；响应和日志不包含 token 或内部堆栈。
- 自动化覆盖情况：HTTP handler 测试覆盖允许与拒绝分支；真实浏览器 Origin 头、Cookie 和代理行为仍需人工验证。
- 当前状态：因无服务器延期。
- 需要保存的证据：脱敏请求与响应、浏览器截图、按 request ID 关联的结构化日志。

### SH-MAN-103 PostgreSQL 身份事务与 Session 持久化

- 前置条件：设置可创建数据库的 `TEST_DATABASE_ADMIN_URL`。
- 操作步骤：执行 `TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration`；观察并发 bootstrap、密码和 Session 数据断言及清理。
- 通过条件：两个并发 bootstrap 只有一个成功；只保存 Argon2id 密码哈希、bootstrap secret 哈希和 Session token 哈希；重置、禁用和撤销立即使旧 Session 失效。
- 自动化覆盖情况：真实 PostgreSQL 集成测试自动创建独立临时数据库、迁移、执行并清理；未设置 URL 时明确 skip。
- 当前状态：因无服务器延期。
- 需要保存的证据：测试输出、脱敏表查询、临时数据库创建与清理记录。

### SH-MAN-104 自托管身份浏览器流程

- 前置条件：以 `VITE_RUNTIME_MODE=self-hosted` 构建并通过同源 HTTPS 提供；全新数据库；管理员及普通账号各一。
- 操作步骤：完成首次管理员创建、管理员登录、创建普通账号、临时密码首次登录、强制改密、退出、重置密码、禁用和 Session 撤销；另以默认构建访问 Firebase 页面。
- 通过条件：临时密码只能进入改密流程；旧 Session 在每项撤销操作后失效；普通账号看不到或不能调用管理功能；默认 Firebase 路由仍可用；没有同一动作双写。
- 自动化覆盖情况：前端组件和 API client 测试覆盖状态分支；真实浏览器、Firebase emulator 回归和网络请求检查需人工或 E2E 执行。
- 当前状态：因无服务器延期。
- 需要保存的证据：关键页面截图、脱敏 HTTP 记录、Firebase emulator 结果和 PostgreSQL 查询。
