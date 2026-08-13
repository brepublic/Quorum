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

## 阶段 3：委员会、席位和规则包

### SH-MAN-201 真实 PostgreSQL 空库 migration 与阶段 3 约束

- 前置条件：PostgreSQL 16；`TEST_DATABASE_ADMIN_URL` 指向可创建和删除数据库的管理员连接。
- 操作步骤：执行 `TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration`；确认测试创建随机临时数据库，从空库执行全部 migration，再执行一次；检查阶段 3 表、外键、部分唯一索引、邀请码约束、已发布规则版本和审计追加限制。
- 通过条件：两次 migration 均成功；当前 schema compatibility 为 21，且 12 个阶段 3 核心表继续存在；同一用户的第二个活动席位被拒绝；已发布规则版本和审计记录不能更新或删除；测试数据库最终清理。
- 自动化覆盖情况：`server/src/db/migrations.integration.test.ts` 检查空库、重复执行和表清单；`server/src/modules/stage3/postgres.integration.test.ts` 检查索引、外键、历史行和不可变触发器。未配置 URL 时测试明确 skip。
- 当前状态：因无服务器延期。
- 需要保存的证据：测试输出、`quorum_meta.schema_migrations`、表与索引查询、触发器失败结果和临时数据库清理记录。

### SH-MAN-202 并发席位分配与邀请码兑换

- 前置条件：阶段 3 migration 已应用；至少一个 Committee Owner、一个 Chair、三个普通账号和两个席位。
- 操作步骤：让两个请求并发为同一用户分配不同席位；结束成功 assignment 后分配新席位；创建只可使用一次的邀请码，再让两个未入会账号并发兑换；撤销另一个邀请码后尝试兑换。
- 通过条件：同一用户始终最多一个活动席位；结束后可使用新席位，旧 assignment 保留为 `ENDED`；同一席位可绑定多个用户；争抢最后一次使用时只有一个请求成功；membership、assignment 和使用次数同时提交或同时回滚；撤销后立即失效。
- 自动化覆盖情况：`server/src/modules/stage3/postgres.integration.test.ts` 使用真实 PostgreSQL 并发兑换并检查部分唯一索引、历史和事务结果。HTTP 层的 Origin、CSRF 与 Session 另由 `server/src/http/stage3-http.test.ts` 覆盖。
- 当前状态：因无服务器延期。
- 需要保存的证据：并发请求结果、脱敏 SQL 查询、邀请码 `code_hash`、assignment 历史、membership 和使用次数。证据不得包含邀请码明文。

### SH-MAN-203 公开与私有委员会快照

- 前置条件：通过 HTTPS 启动真实应用和 PostgreSQL；建立 PUBLIC 与 PRIVATE 委员会，并准备匿名、普通登录、member、Chair 和 Owner 五种访问者。
- 操作步骤：分别请求两个委员会的 `/api/v1/committees/:id/snapshot`；检查状态码、viewer audience、席位、membership、assignment、revision 和事件序号；搜索响应中的邮箱、邀请码、哈希、capability 与审计字段。
- 通过条件：PUBLIC 匿名请求成功且只含公开字段；PRIVATE 匿名和非 member 均返回不泄露存在性的 404；member 只收到自己的 membership 与 assignment；Chair 和 Owner 收到授权管理字段；所有响应均不含邮箱、秘密或审计。
- 自动化覆盖情况：`server/src/http/stage3-http.test.ts` 覆盖匿名路由与统一安全响应；`server/src/modules/stage3/postgres.integration.test.ts` 覆盖 audience 和字段过滤。真实 Cookie、TLS、反向代理和跨请求 Session 仍需人工验证。
- 当前状态：因无服务器延期。
- 需要保存的证据：五种访问者的脱敏响应、状态码、request ID、代理日志和字段差异表。

### SH-MAN-204 规则包导入、克隆、版本、校验、模拟和激活

- 前置条件：真实阶段 3 实例；系统管理员、Committee Owner、Chair 和普通 member 各一；准备有效包和含未知字段、未知事实、循环继承、类型错误、除以零与超限表达式的无效包。
- 操作步骤：列出两个内置包；分别导入 SYSTEM 与 COMMITTEE 包；克隆内置包；创建草稿和已发布版本；尝试修改已发布版本；校验并模拟有效及无效定义；由 Owner、系统管理员和 Chair 分别尝试激活和覆盖；创建 `ONCE` 与 `FUTURE` 覆盖。
- 通过条件：两个内置包通过校验且不可修改；只有系统管理员可管理 SYSTEM 包，只有目标委员会 Chair 可管理、激活和覆盖委员会规则；无效包稳定返回 422；模拟不写业务状态；激活使用 revision；`FUTURE` 创建新版本但不自动激活；旧冻结规则快照保持不变。
- 自动化覆盖情况：`packages/rule-schema/src/index.test.ts` 覆盖校验、表达式、复杂度、继承、模拟与解析顺序；`packages/contracts/src/stage3.test.ts` 覆盖冻结快照；`server/src/modules/stage3/postgres.integration.test.ts` 覆盖作用域、能力、版本、激活、覆盖和数据库不可变性。
- 当前状态：因无服务器延期。
- 需要保存的证据：脱敏 API 响应、数据库版本与绑定查询、模拟前后业务表计数、授权拒绝结果、规则快照比较和按 request ID 关联的审计。

## 阶段 4：低并发业务切片

### SH-MAN-301 阶段 4 migration 与 PostgreSQL 事务

- 前置条件：PostgreSQL 16；`TEST_DATABASE_ADMIN_URL` 指向可创建和删除数据库的管理员连接。
- 操作步骤：执行 `TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration`；检查 migration 4、模板隔离、幂等键、revision 冲突、软删除、并发点名和追加式出席事件用例。
- 通过条件：schema compatibility 为 21；migration 4 的表、外键、唯一索引和追加式触发器均生效；并发写只有一个符合 revision 的请求成功；临时数据库最终清理。
- 自动化覆盖情况：migration 与 `server/src/modules/stage4/postgres.integration.test.ts` 已实现；当前环境未提供 PostgreSQL，因此明确 skip。
- 当前状态：因无服务器延期。
- 需要保存的证据：测试输出、migration 表、阶段 4 表与索引查询、并发结果和临时数据库清理记录。

### SH-MAN-302 模板、席位、笔记和文本帖子浏览器流程

- 前置条件：通过 TLS 提供 `VITE_RUNTIME_MODE=self-hosted` 构建；Owner、Chair 和两个 member 账号；两个独立浏览器配置文件。
- 操作步骤：创建、克隆、重命名和删除账号级国家/委员会模板；从模板创建委员会；修改源模板并确认席位/国旗快照不变；创建、编辑和删除笔记及文本帖子；制造陈旧 revision 后刷新。
- 通过条件：账号模板互相隔离；模板删除冲突列出当前账号占用项；席位快照不随源模板变化；帖子权限符合 member/Chair/Owner 矩阵；删除后正文清空；409 后页面重新读取且不覆盖新版本。
- 自动化覆盖情况：契约、HTTP、前端和 PostgreSQL 集成测试覆盖命令与权限；真实 WebP 选择、双浏览器交互和代理 Cookie 仍需人工确认。
- 当前状态：因无服务器延期。
- 需要保存的证据：关键页面截图、两浏览器请求时间线、脱敏 API 响应、模板/席位 SQL 查询和审计摘要。

### SH-MAN-303 点名、出席与暂停状态

- 前置条件：真实阶段 4 实例；含至少三个活动席位的委员会；两名 Chair 登录不同浏览器。
- 操作步骤：开始会期和点名；同时提交同一 revision；撤销和重置；完成含“出席并参与表决”的点名；追加暂时离场、返回和缺席事件；把委员会暂停后重试议事命令。
- 通过条件：同一会期只有一个进行中点名；并发提交只有一个成功；冻结席位名称和规则回答不受后续修改影响；完成后当前出席可由事件重建；暂停时会期、点名和出席命令返回 409，笔记和帖子仍可编辑。
- 自动化覆盖情况：服务端和真实 PostgreSQL 集成用例已编写；当前环境只执行了无数据库测试。
- 当前状态：因无服务器延期。
- 需要保存的证据：两个浏览器的响应、点名/entry/attendance 表查询、事件 sequence、审计记录和暂停状态结果。

### SH-MAN-304 问题、主席代办与关联出席事件

- 前置条件：激活北京学术标准规则包；分别建立 `DELEGATE_OPERATED` 与 `CHAIR_OPERATED` 委员会；member、Chair、Owner 和系统管理员账号。
- 操作步骤：由 member 提出本人席位问题；由 Chair 代席位提出；尝试未知和停用类型；回应普通问题并尝试附带出席变化；回应个人特权问题并附带出席变化；重复回应。
- 通过条件：actor 和代办席位由服务端权限推导；运作模式矩阵生效；普通问题不能改变出席；个人特权问题、出席事件、当前状态、事件和审计同事务提交；重复回应返回 409；系统管理员无隐式 Chair 权限。
- 自动化覆盖情况：HTTP 与 PostgreSQL 集成测试覆盖这些分支；真实 Session、代理和多账号 UI 仍需人工确认。
- 当前状态：因无服务器延期。
- 需要保存的证据：脱敏 API 响应、point/attendance/audit 联表查询、不同角色的拒绝结果和 request ID。

### SH-MAN-305 schema v2 快照、匿名公开访问与跨浏览器刷新

- 前置条件：PUBLIC 与 PRIVATE 委员会；匿名、非 member、member、Chair、Owner 和系统管理员访问者；两个浏览器。
- 操作步骤：访问深层委员会路由并刷新；比较各 audience 快照；在一个浏览器修改笔记、点名或问题，在另一个窗口重新聚焦并显式刷新；检查网络请求。
- 通过条件：PUBLIC 匿名页面可读取公开字段；PRIVATE 未授权访问统一 404；公开响应不含 owner、用户 ID、actor、私有正文、主席内部回应或审计；member/Chair/Owner 字段逐级增加；重新聚焦可取得最新快照；网络中没有 Firebase 请求。
- 自动化覆盖情况：快照过滤、HTTP 匿名路由、前端 focus revalidation 和静态边界已有测试；阶段 5 会在同源 `/events` 上建立 SSE，真实深层 SPA fallback、TLS、多浏览器和网络面板需人工确认。
- 当前状态：因无服务器延期。
- 需要保存的证据：各 audience 脱敏响应差异、浏览器截图、网络 HAR、深层路由刷新结果和代理日志。

## 阶段 5：实时与高并发议事

当前环境未提供 `TEST_DATABASE_ADMIN_URL`、Docker、Caddy、TLS 或多浏览器。阶段 5 的真实 PostgreSQL 集成文件已编写但在本环境明确 skip；以下项目均未标记为通过。

### SH-MAN-401 migration 5–12 与并发约束

- 前置条件：PostgreSQL 16；`TEST_DATABASE_ADMIN_URL` 指向可创建和删除数据库的管理员连接。
- 操作步骤：执行 `TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration`；保留 migration 5–12、两名 Chair 并发重排和同席位两名代表并发投票的输出。
- 通过条件：schema compatibility 为 21；空库 migration 和重复执行成功；并发重排只有一个 revision 成功且活动位置唯一；同席位并发投票只有一张当前票；临时数据库被清理。
- 自动化覆盖情况：`server/src/db/migrations.integration.test.ts` 与 `server/src/modules/stage5/postgres.integration.test.ts` 已实现；未配置 URL 时明确 skip。
- 当前状态：因无服务器延期。
- 需要保存的证据：完整测试输出、`quorum_meta.schema_migrations`、相关唯一索引和触发器查询、两组并发结果及临时数据库清理记录。

### SH-MAN-402 SSE 游标、断线补偿和权限变化

- 前置条件：Caddy HTTPS 实例；PUBLIC、member、Chair、Owner 四种身份；可调整代理断线和事件保留游标。
- 操作步骤：同时传入不同的 `Last-Event-ID` 与 `after`；断开后重连；把游标调到保留范围之前；注入客户端未知事件；连接期间撤销 membership 或 Chair 能力；检查同一浏览器重复打开同委员会页面。
- 通过条件：服务端采用更新且有效的游标；有效断线按序补齐；过期游标稳定返回 410 并触发完整快照；序号缺口或未知事件不应用部分状态；权限变化后连接重新鉴权并关闭；每浏览器每委员会最多一条流。
- 自动化覆盖情况：realtime service、HTTP SSE 和前端同步状态测试覆盖游标选择、410、未知事件和单流；真实代理断线、浏览器复用及权限时序需人工确认。
- 当前状态：因无服务器延期。
- 需要保存的证据：HAR、SSE frame 序号、410 响应、快照请求、撤权时间线、服务端 request ID 和浏览器连接数。

### SH-MAN-403 SSE 心跳与 Caddy 禁用缓冲

- 前置条件：真实 Caddy 反向代理；可用 `curl -N` 和浏览器网络面板。
- 操作步骤：在无业务事件时保持流至少两个心跳周期；分别直连应用和经 Caddy 访问；记录首字节和每次心跳到达时间。
- 通过条件：响应为 `text/event-stream`，含 `Cache-Control: no-cache` 与 `X-Accel-Buffering: no`；心跳及时逐条到达，不成批缓冲；断开能被服务端释放。
- 自动化覆盖情况：HTTP 和部署配置测试检查响应头、心跳与 `flush_interval -1`；真实代理行为未执行。
- 当前状态：因无服务器延期。
- 需要保存的证据：`curl -N` 时间戳、响应头、Caddy 配置、代理日志和断开前后连接计数。

### SH-MAN-404 权威计时、发言队列、让渡和主席代办

- 前置条件：两个 Chair、三个出席席位、`DELEGATE_OPERATED` 与 `CHAIR_OPERATED` 委员会各一；两个浏览器。
- 操作步骤：开始、暂停、恢复、延长、重置并等待到期；修改客户端系统时钟；并发重排和切换发言人；尝试未暂停切换；完成不足一次发言时间的有主持核心磋商；执行四类让渡并尝试二次让渡；由 Chair 代席位记录问题和评论。
- 通过条件：数据库不产生每秒写入；显示由服务器基线和单调时钟推导，修改系统时钟不改变真实剩余时间；队列顺序和当前发言人唯一；未暂停不能切换；不足完整发言时结束磋商；继承时间不能再次让渡；审计同时记录真实 actor 与代行席位。
- 自动化覆盖情况：计时纯函数、服务命令、迁移约束和 PostgreSQL 并发测试覆盖核心边界；真实时钟篡改、两个浏览器和长时间到期需人工确认。
- 当前状态：因无服务器延期。
- 需要保存的证据：数据库写入时间线、两浏览器响应、计时截图、queue/timer/speech/action/audit 查询和时钟修改前后对比。

### SH-MAN-405 动议与正式 ballot

- 前置条件：已发布规则包；含普通、must-vote 和否决席位的委员会；同一席位绑定两名代表；两名 Chair。
- 操作步骤：由出席和缺席席位分别提出及附议；并发裁决同一 revision；创建程序性与实质性 ballot；同席位并发投票；代表尝试改票；Chair 更正；在 must-vote 未齐和否决席位未齐时结束；收齐后公布通过、未通过和否决结果。
- 通过条件：动议规则版本和评估快照冻结；状态只能经命令迁移且通过/未通过都保留时间和 actor；ballot 冻结资格、门槛、must-vote、否决和规则版本；程序性 ballot 无弃权；代表不能改票；更正追加历史；否决席位存在时收齐合资格票后才公布。
- 自动化覆盖情况：迁移、服务、HTTP 和 PostgreSQL 并发测试覆盖状态机、一席一票及历史；真实多账号 UI 和全部结果矩阵需人工确认。
- 当前状态：因无服务器延期。
- 需要保存的证据：motion/ballot/vote/revision/event/audit 查询、并发响应、公布前后快照和各角色页面截图。

### SH-MAN-406 匿名与席位意向性投票

- 前置条件：匿名和席位实名意向性投票各一；member、Chair、PUBLIC 访问者；可查询测试数据库。
- 操作步骤：匿名投票后检查快照、SSE、审计、receipt 和 selection 表；同一账号重复投票；席位模式下让同席位两名代表并发投票；尝试把意向性结果作为正式 ballot 输入。
- 通过条件：两种模式清晰标识；匿名 receipt 与 selection 无共同标识或时间，事件/快照仅含聚合，审计不含选项 ID；重复匿名身份和重复席位只有一次成功；没有转换为正式 ballot 的命令或数据路径。
- 自动化覆盖情况：迁移静态测试、HTTP 边界和 PostgreSQL 集成用例已实现；匿名关联攻击审查和真实浏览器流程需人工确认。
- 当前状态：因无服务器延期。
- 需要保存的证据：脱敏表结构与查询、SSE payload、快照、审计摘要、重复请求结果和 API 路由清单。

### SH-MAN-407 决议草案、修正案与冻结版本

- 前置条件：包含阶段 5 文档稳定 ID 的已发布规则包；Chair 和两个出席 member。
- 操作步骤：创建决议草案和修正案；创建新版本；按稳定 ID 发布、讨论、延置、恢复和建议表决；进入表决后尝试替换当前版本；创建 ballot 并公布结果。
- 通过条件：每次正文修改新增不可变版本；规则动作引用冻结包中的唯一稳定 ID；进入表决时固定 `voting_version_id`，服务和数据库都拒绝替换；ballot 发布与文档最终状态在同一事务完成；没有 file entry、上传或 Local Agent 路径。
- 自动化覆盖情况：规则 fixture、迁移触发器、HTTP、服务和 PostgreSQL 集成用例已实现；真实角色 UI 和数据库触发器执行需人工确认。
- 当前状态：因无服务器延期。
- 需要保存的证据：document/version/action/discussion/ballot/event/audit 查询、拒绝响应、规则快照和各状态页面截图。

### SH-MAN-408 Firebase 与自托管运行时回归

- 前置条件：Java 21、Firebase Emulator Suite、已安装 Cypress 二进制，以及独立自托管测试实例。
- 操作步骤：运行 `pnpm test:e2e`；分别构建默认与 `VITE_RUNTIME_MODE=self-hosted`；在两个浏览器检查网络请求和相同业务动作。
- 通过条件：Firebase emulator/Cypress 既有用例通过；默认构建仍只走 Firebase；自托管构建只走同源 API/SSE；任何动作都不双写；简体中文议事控件和状态可读。
- 自动化覆盖情况：两个生产构建和 runtime 静态测试已实现。当前 WSL 已在 Firebase Auth、Database、Storage、Functions emulators 与 Electron 118 上运行 Cypress 13.11.0，4 个 spec、22 项全部通过；该套件只验证既有 Firebase 运行时，不能替代自托管 PostgreSQL 网络与视觉验收。
- 当前状态：Firebase emulator/Cypress 回归已通过；自托管 TLS、多浏览器网络和双写检查因无服务器延期。
- 需要保存的证据：Cypress 输出、两个构建日志、两份 HAR、浏览器截图及 Firebase/PostgreSQL 写入对比。

## 阶段 6：服务器卷和 S3 文件

当前环境未提供 `TEST_DATABASE_ADMIN_URL`、PostgreSQL 客户端、Docker 持久卷、S3 兼容测试桶或 TLS 浏览器。阶段 6.1–6.8 的真实 PostgreSQL 集成测试已编写但明确 skip；以下项目尚未通过。

### SH-MAN-501 文件版本、绑定、事务和墓碑

- 前置条件：PostgreSQL 16；`TEST_DATABASE_ADMIN_URL` 指向可创建和删除数据库的管理员连接。
- 操作步骤：执行 `TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration`；检查 migration 13；创建服务器卷绑定和两个文件版本；注入审计写入失败；删除文件后尝试修改版本、删除墓碑和追加旧文件版本。
- 通过条件：schema compatibility 为 21；一个委员会最多一个活动 binding；版本保存服务端大小和 SHA-256 且不可修改；故障时文件、事件、审计和幂等记录全部回滚；删除立即清除当前版本、追加唯一墓碑并标记 blob 待删；旧副本不能追加版本；系统管理员没有隐式 Chair 权限。
- 自动化覆盖情况：migration 静态测试和无数据库校验已通过；`server/src/modules/storage/postgres.integration.test.ts` 覆盖真实 PostgreSQL 事务、追加历史、故障回滚和删除防复活，未配置 URL 时明确 skip。
- 当前状态：因无服务器延期。
- 需要保存的证据：完整测试输出、migration 13 表/约束/触发器查询、file entry/version/blob/tombstone 脱敏查询、事件与审计计数、故障注入回滚结果和临时数据库清理记录。证据不得包含二进制内容或 provider 密钥。

### SH-MAN-502 durable staging、HTTP 流和故障恢复

- 前置条件：真实 PostgreSQL 16；应用的 `QUORUM_STORAGE_PATH` 挂载到持久卷；通过 Caddy TLS 访问；准备 member 与 Chair 账号、活动和暂停委员会，以及可注入满盘、只读卷、断流和进程终止的测试环境。
- 操作步骤：创建 upload 后分别以固定 `Content-Length` 和 chunked 请求分块上传；验证实际大小和 SHA-256；尝试超限、短写、长写、断流、错误哈希、只读卷、满盘、绝对路径、`..`、符号链接和目录/FIFO 目标；在字节落盘后、最终数据库事务前终止进程，重启后以同一幂等键重试；把委员会暂停后尝试创建和完成；把 `CREATED`、`RECEIVING` 与 `STAGED` 的期限调到过去并运行未来清理候选查询。
- 通过条件：请求内存不随完整文件大小增长；成功 upload 的服务器实算大小和 SHA-256 匹配，内部键不含用户文件名；所有失败均不创建 file entry、blob、version 或下载记录；完整暂存副本在数据库或进程故障后保留并可恢复；暂停状态拒绝创建和完成；普通期限不会选择 `CREATED`、`RECEIVING` 或 `STAGED`，只选择 `COMMITTED`、`CANCELLED` 或已过期的 `FAILED`。
- 自动化覆盖情况：migration、纯文件系统流、HTTP 边界和 PostgreSQL 集成用例已实现；当前 WSL 的无数据库测试验证流式分块、大小/哈希、超限、断流、磁盘错误、路径和清理候选。真实持久卷、进程终止、代理 chunked 传输、内存曲线和 PostgreSQL 事务尚未执行。
- 当前状态：因无服务器延期。
- 需要保存的证据：脱敏请求与响应、进程 RSS 时间线、暂存卷路径类型与 SHA-256、upload/event/audit/idempotency 查询、file 表计数、重启前后状态、代理日志和清理候选查询。证据不得包含 Session、CSRF token 或文件正文。

### SH-MAN-503 SERVER_VOLUME 原子提交与故障恢复

- 前置条件：真实 PostgreSQL 16；`QUORUM_STORAGE_PATH` 挂载到支持 `fsync` 与同文件系统硬链接的持久卷；通过 Caddy TLS 访问；准备活动和暂停委员会，以及可注入只读卷、满盘、I/O、数据库审计写入失败、进程终止和宿主机重启的环境。
- 操作步骤：把同一 `STAGED` upload 提交到 `SERVER_VOLUME`；核对最终路径、权限、大小和 SHA-256；分别在打开临时文件、写入、文件 `fsync`、原子发布、目录 `fsync`、最终重读和数据库事务处注入失败；以同一幂等键重试，再以不同请求复用该键；构造符号链接、硬链接、目录和 FIFO 目标；在 provider 发布后数据库提交前终止进程并重启；暂停委员会后尝试提交。
- 通过条件：最终路径只由 blob UUID 派生且权限为 0600；已提交内容在应用和宿主机重启后仍可校验读取；任一 provider 失败均不创建 file version 且保留 `STAGED`；数据库失败保留暂存和完整 provider 字节，重试只产生一个 blob、entry 和 version；upload、文件元数据、事件、审计和幂等响应原子一致；路径替换被拒绝；暂停状态拒绝提交；已发布 provider 内容不被暂存期限或 LRU 删除。
- 自动化覆盖情况：纯文件系统测试覆盖流式复制、文件打开/`fsync`/原子发布失败、最终重读校验、幂等目标复用及符号链接、硬链接和非普通文件拒绝；HTTP 测试覆盖 Session、Origin、CSRF 与幂等边界；真实 PostgreSQL 用例覆盖提交精确一次、审计故障回滚重试和暂停拒绝，未配置 URL 时明确 skip。真实挂载卷的断电耐久性、目录 `fsync`、满盘、进程/宿主机重启及 TLS 代理尚未执行。
- 当前状态：因无服务器延期。
- 需要保存的证据：完整测试输出、挂载类型与选项、最终文件 `stat`/SHA-256、数据库 upload/blob/entry/version/event/audit/idempotency 脱敏查询、每个故障点的前后状态、重启前后读取结果和 Caddy 日志。证据不得包含 Session、CSRF token、文件正文或未来 S3 凭据。

### SH-MAN-504 S3 compatible 配置、网络边界和提交恢复

- 前置条件：真实 PostgreSQL 16；独立 S3 compatible 测试桶；TLS 与 DNS 可控的测试域名；可轮换的测试 access key；显式 32 字节 `QUORUM_STORAGE_MASTER_KEY`；可注入 DNS rebinding、TLS、网络中断、限速、拒绝权限和数据库事务故障的环境。
- 操作步骤：系统管理员创建、更新、停用和验证 S3 配置；普通用户和 Chair 尝试管理配置或读取凭据；使用错误 master key、旧 key version 和篡改密文启动/提交；测试 HTTP、URL 凭据、query、fragment、回环、链路本地、元数据、私网和 DNS 解析后变址；Chair 绑定活动配置后分块上传并提交，检查 object key、SigV4、远端大小和 SHA-256；分别中断 PUT、制造短对象/篡改对象/GET 失败并注入数据库审计故障，以同一幂等键重试；暂停委员会后提交。
- 通过条件：数据库、响应、日志、事件和审计均无明文凭据；错误或不可用 master key 稳定失败且不回退；只有系统管理员管理配置，Chair 只能绑定活动配置；危险 endpoint 和 DNS rebinding 被拒绝；object key 只由 prefix/blob UUID 派生；PUT 后完整 GET 校验；任一远端或数据库失败均不产生部分文件版本，保留暂存，重试只产生一个 blob/version；暂停状态拒绝提交。
- 自动化覆盖情况：当前 WSL 的单元测试覆盖 AES-256-GCM 往返、篡改/错 key/跨配置重放、URL 与 IP SSRF、DNS 后连接地址校验入口、blob key、流式 PUT/GET 校验和 S3 故障；HTTP 与静态 migration 测试已实现；真实 PostgreSQL 用例覆盖权限、密文、binding 和精确一次提交，未配置 URL 时明确 skip。真实 S3 的 SigV4 兼容性、DNS/TLS、multipart、大文件内存、权限、限速和故障重试尚未执行。
- 当前状态：因无服务器与测试桶延期。
- 需要保存的证据：脱敏配置响应、数据库密文长度和 key version、审计/log 搜索结果、DNS 与 TLS 记录、对象 key/metadata/远端 SHA-256、每个故障点的 upload/blob/version/idempotency 查询、重试结果和 provider 日志。任何证据不得包含 access key、secret、master key、Session、CSRF token 或文件正文。

### SH-MAN-505 文件审核、授权下载和永久删除恢复

- 前置条件：真实 PostgreSQL 16；通过 Caddy TLS 运行 self-hosted 服务；一个 PUBLIC 和一个 PRIVATE 委员会；Owner、Chair、活动 member、非 member 和未登录浏览器；服务器持久卷与独立 S3 compatible 测试桶；可暂停委员会、停用 S3 配置、篡改测试对象并终止 worker 进程的隔离环境。
- 操作步骤：上传文件后分别以未登录、非 member、member、Chair 和 Owner 调用列表、详情及下载；依次提交审核和发布，并尝试错误角色、陈旧 revision、相同/冲突幂等键及暂停状态；上传包含中文、路径片段、引号、CR/LF 的文件名，以及 HTML、XML、JavaScript、SVG、PDF 和普通二进制类型；在服务器卷与 S3 上分别下载并核对大小/SHA-256，停用 S3 配置后再次读取已有 blob；篡改或移除 provider 内容后请求下载；创建多版本文件并逻辑删除，检查即时不可见、墓碑、所有 blob delete job，再分别注入 provider 删除失败、数据库完成事务失败和 worker 在 claim/远端删除后的进程终止，等待 claim 超时后重跑。
- 通过条件：PRIVATE 委员会不向未授权调用者泄漏存在性；PUBLIC 只公开 `PUBLISHED` 文件，member/Chair/Owner 权限符合契约，系统管理员没有隐式 Chair 权限；暂停状态拒绝审核、发布和删除；状态、事件、审计与幂等响应原子一致；下载在 200 前完成 provider 完整性预检，文件名不能注入响应头，所有类型强制 attachment，危险类型返回 `application/octet-stream`，TLS 浏览器中不能同源执行；逻辑删除立即使列表、详情和下载返回 404，墓碑不含正文；每个历史版本 blob 最终只完成一个删除任务，失败保留 `DELETE_PENDING` 并退避，进程崩溃后的 stale claim 可恢复，已不存在的对象按成功收敛，停用配置不妨碍已有 S3 blob 的读取或删除。
- 自动化覆盖情况：migration、下载头、HTTP 路由、SERVER_VOLUME/S3 删除原语和共享契约测试已在当前 WSL 通过；真实 PostgreSQL 用例覆盖角色、公开/私有可见性、revision、幂等重放、暂停、状态/事件/审计原子性、服务器卷/S3 下载、逻辑删除、删除任务完成/重试/stale claim 和停用配置读取，未配置 URL 时明确 skip。真实 TLS 浏览器的响应头执行隔离、大文件下载内存、真实 S3 停用配置、进程终止、数据库完成故障和持久卷重启尚未执行。
- 当前状态：因无服务器、真实 PostgreSQL、测试桶和 TLS 浏览器延期。
- 需要保存的证据：各角色脱敏响应矩阵、浏览器 Network/Security 截图、`Content-Disposition`/`Content-Type`/安全头、下载 SHA-256、file entry/version/blob/tombstone/delete-job/event/audit/idempotency 脱敏查询、provider 对象前后清单、每次故障与重启的时间线及 worker 日志。不得保存文件正文、Session、CSRF token、S3 凭据或 master key。

### SH-MAN-506 provider 切换、回退与进程恢复

- 前置条件：真实 PostgreSQL 16；一个持久 `SERVER_VOLUME`；至少两个独立、当前 revision 已验证的 S3 compatible 配置；Owner、Chair、普通 member 和系统管理员账号；可篡改或删除测试对象、暂停委员会、终止应用进程并并行启动两个应用实例的隔离环境。
- 操作步骤：创建含多个文件和历史版本的委员会，分别执行 `SERVER_VOLUME→S3`、`S3→SERVER_VOLUME` 和两个 S3 配置间的迁移；复制期间持续下载并核对仍由源 binding 服务；分别制造源短写/长写/哈希错误、目标 PUT/GET 失败、目标对象损坏、数据库 item 完成事务失败，以及目标写成功后立即终止进程；等待 stale claim 后恢复并重试。复制期间新增版本和删除文件，确认 manifest 冲突后重新规划；在 `READY_TO_CONFIRM` 后损坏目标再确认；分别测试陈旧 revision、重复幂等键、不同请求复用同一键、错误角色、只有系统管理员角色、暂停/归档状态、并发创建、取消及取消后晚到完成。最后确认成功迁移并下载全部当前版本，再停用源 S3 配置检查退休源副本仍可供受控恢复。
- 通过条件：复制、失败和重试期间 `committees.active_storage_binding_id` 与下载来源始终保持旧 provider；目标 key 和 durable staging key 不含用户文件名；每个目标副本重读后的大小和 SHA-256 与逻辑内容一致；失败、进程终止、stale claim 或数据库回滚不会产生部分 binding 切换或重复逻辑版本；manifest 变化要求显式 retry，确认前再次损坏目标会拒绝切换；成功确认在一个事务内退役源 binding、激活目标 binding、更新委员会和完成 migration，历史 `file_versions.blob_id` 保持不变；取消保持源内容，目标副本和取消后晚到写入只进入 durable delete job；Owner/Chair 以外角色、暂停/归档状态和陈旧 revision 被拒绝，系统管理员没有隐式 Chair 权限；同一幂等请求精确重放，冲突请求被拒绝；两个应用实例可以通过 claim token 协作且旧 worker 不能覆盖新 claim。
- 自动化覆盖情况：当前 WSL 的 migration 静态、copy streaming、HTTP、worker 和共享契约测试已通过；真实 PostgreSQL 用例覆盖双向 provider 切换、故障/重试、manifest 变化、取消、权限、暂停、revision、幂等与事务原子性，未配置 `TEST_DATABASE_ADMIN_URL` 时明确 skip。真实 S3、持久卷、进程终止、两个应用实例、网络故障和退休源恢复尚未执行。
- 当前状态：因无真实 PostgreSQL、持久卷、S3 compatible 测试桶和多实例环境延期。
- 需要保存的证据：迁移/item/copy/binding/file blob/event/audit/idempotency 脱敏查询、源与目标对象清单和 SHA-256、下载来源与结果、每个故障点的时间线、进程终止及 stale claim 恢复日志、两个实例的 claim token 记录和最终 active binding。不得保存文件正文、Session、CSRF token、S3 凭据或 master key。

### SH-MAN-507 容量阈值、后台清理与指标

- 前置条件：真实 PostgreSQL 16；`QUORUM_STORAGE_PATH` 是可独立扩容、填充、设为只读并观察挂载信息的持久卷；SERVER_VOLUME 与 S3 compatible 测试内容；两个并行应用实例；可在 unlink、provider delete 和数据库完成事务之间终止进程或注入故障；可访问 `/health/ready` 和 `/metrics`。
- 操作步骤：把容量依次调整到 79%、80%、89%、90% 并恢复，另制造 `statfs` 失败、只读卷和满盘；每个状态下分别创建 upload、发送内容、运行 provider migration copy、下载文件、执行议事命令、逻辑删除和 cleanup。准备 `CREATED`、`RECEIVING`、`STAGED`、`COMMITTED`、`CANCELLED`、未过期/已过期 `FAILED` upload，以及 `PENDING`、`IN_PROGRESS`、`RETRY`、`COMPLETED`、`CANCELLED` migration item；运行两个 worker 并检查实际 staging 文件。对 SERVER_VOLUME/S3 delete job 和两类 staging cleanup 分别注入 provider/unlink 失败、数据库完成回滚、unlink 后进程终止和 stale claim；重复运行到收敛。检查容量状态转换日志、readiness 与 Prometheus 指标，并搜索路径、文件名、正文和凭据。
- 通过条件：79% 为 normal，80%/89% 为 warning，90% 为 critical；critical 和容量未知均拒绝新的 upload 字节及 provider copy，但仍有空间的 critical 不阻止下载、议事、删除或回收。采样失败、可用字节为零、只读或必要存储不可用使 readiness 返回统一 503；仍有空间的 warning/critical 返回 200 并报告状态。只有 `COMMITTED`、`CANCELLED`、过期 `FAILED` upload 和 `COMPLETED`/`CANCELLED` migration staging 被清理；唯一 `STAGED`、活动 claim、待重试 copy 和退休源副本保留。多实例只由一个有效 token 完成每次状态写入；物理目标已不存在按成功收敛；provider 成功但数据库回滚可重试；维护审计追加保存每次成功/失败。`/metrics` 的使用率、可用字节、三类队列深度和结果计数与数据库一致，日志与指标不泄漏敏感信息。
- 自动化覆盖情况：当前 WSL 的阈值边界、容量拒绝、readiness/metrics、staging 路径删除、worker 串行停止、migration copy 门控和静态 migration 测试已通过；真实 PostgreSQL 用例覆盖 upload 幂等回放、严格候选、cleanup 失败恢复、provider 删除数据库完成回滚、stale claim 和追加式审计，未配置 `TEST_DATABASE_ADMIN_URL` 时明确 skip。真实挂载卷使用率、只读/满盘、两个进程、真实 S3、进程终止、Prometheus 抓取和日志采集尚未执行。
- 当前状态：因无真实 PostgreSQL、可控持久卷、S3 compatible 测试桶和多实例环境延期。
- 需要保存的证据：`df`/挂载信息、四个阈值的 readiness 与 metrics、上传/下载/议事结果、cleanup claim 和 audit 脱敏查询、staging/provider 对象清单、两个实例日志、每个故障点和恢复时间线、敏感信息搜索结果。不得保存文件正文、Session、CSRF token、S3 凭据、master key 或含秘密的完整路径。

### SH-MAN-508 自托管文件与存储管理浏览器流程

- 前置条件：通过 Caddy TLS 提供 `VITE_RUNTIME_MODE=self-hosted` 构建；真实 PostgreSQL 16、持久 `SERVER_VOLUME` 和独立 S3 compatible 测试桶；PUBLIC 与 PRIVATE 委员会；未登录、非 member、member、Chair、Owner 和仅有 `SYSTEM_ADMIN` 的账号；Chromium、Firefox、Safari，以及窄屏触控设备或模拟器；准备大文件、中文长文件名、HTML、JavaScript、SVG、PDF 和普通二进制文件，并可制造 90% 容量、容量未知、provider 中断、暂停委员会与陈旧 revision。
- 操作步骤：逐角色进入委员会“文件”视图并记录可见文件和操作；member 选择大文件，观察分块校验、真实上传进度、取消、失败后重试和成功后的“上传完成”；提交审核后确认“待审核”，由 Chair/Owner 发布并确认“已发布”；在另一浏览器同步观察列表刷新。下载每种文件并检查 Network 响应头，确认页面未创建 iframe、object、embed、data URL 或内联预览。确认永久删除后立即再次列表和下载。由 Chair/Owner 初始化服务器卷或 S3，执行 `COPYING`、`FAILED`、`READY_TO_CONFIRM`、`COMPLETED` 和 `CANCELLED` 迁移流程。由系统管理员创建、编辑、停用和验证 S3 配置，检查密码字段、DOM、Network、控制台和日志。分别触发 90% 容量、容量未知、provider 故障、revision/幂等冲突、暂停与权限拒绝。最后用键盘完成文件选择以外的全部操作，检查焦点、可访问名称、44 px 触控目标、窄屏换行和简体中文长文本。
- 通过条件：PUBLIC 只显示公开委员会已发布文件；member、Chair、Owner 和系统管理员显示/操作矩阵与服务端一致，系统管理员没有隐式 Chair 控件。浏览器校验和上传不复制完整大文件到多份内存，进度对应实际字节，可取消且失败后可重试；成功依次显示“上传完成”“待审核”“已发布”。409 后重新读取权威状态，不静默覆盖。下载只走 attachment 路由，危险 MIME 不在同源页面执行。永久删除后文件立即不可见且下载返回 404。只有系统管理员可编辑 endpoint 和凭据，已保存凭据不在响应、DOM、控制台或日志中回显。迁移操作、错误恢复、键盘、焦点、窄屏和触控均可用。
- 自动化覆盖情况：当前 WSL 的 API client、增量 SHA-256、XHR 进度/取消、角色矩阵、危险 MIME 无预览、上传成功/失败重试、审核发布删除刷新、迁移状态、S3 凭据不回填、HTTP binding 和共享契约测试已通过；真实 PostgreSQL binding 权限用例未配置 URL 时明确 skip。Cypress 13.11.0 已运行既有 Firebase 4 个 spec、22 项全通过，但尚无覆盖自托管文件页的 Cypress spec。真实浏览器 File/Blob 内存曲线、XHR 网络进度、下载行为、跨浏览器 SSE、视觉布局、触控、键盘焦点、TLS、真实 provider 和容量故障仍未执行。
- 当前状态：因无真实 PostgreSQL、持久卷、S3 compatible 测试桶和 TLS 自托管实例延期。
- 需要保存的证据：各角色与状态截图、窄屏和焦点截图、辅助功能树、浏览器任务管理器内存曲线、上传/取消/重试 Network 时间线、SSE 与列表刷新 HAR、attachment 响应头、下载 SHA-256、删除后的 404、binding/migration/file/event/audit/idempotency 脱敏查询、S3 配置响应和凭据泄漏搜索结果。不得保存文件正文、Session、CSRF token、access key、secret 或 master key。

## 阶段 7：Chair Local Agent

当前环境未提供 `TEST_DATABASE_ADMIN_URL`、自托管 TLS 实例、第二台真实设备或桌面签名环境。阶段 7.1–7.6 的自动验证已在 WSL 执行，PostgreSQL 集成测试明确 skip；以下实机项目尚未通过。

### SH-MAN-509 Agent 配对、单主机 fencing 与离线降级

- 前置条件：真实 PostgreSQL 16；通过 Caddy TLS 运行的自托管服务；Owner、Chair、member 和仅有 `SYSTEM_ADMIN` 的账号；两台隔离设备或两个独立 Agent 测试进程；可断网、延迟请求和检查数据库/服务日志。
- 操作步骤：分别由 Owner 和 Chair 创建 `INITIAL` 配对码，检查明文只出现一次并在 10 分钟后失效；让 member 和系统管理员尝试创建、查看和撤销。用设备 A 配对并心跳，重用同一码；创建 `TRANSFER` 码但暂不消费，确认 A 仍有效；让设备 B 消费并同时发送 A 的迟到 heartbeat/未来 task 完成；撤销 B 后再次发送。并发消费同一码和并发初始配对。配对码创建后撤销签发 Chair 权限再消费。停止心跳超过宽限期，继续执行点名、动议、投票和计时，再恢复 heartbeat。搜索数据库、响应历史、浏览器存储、代理日志、应用日志、事件和审计中的配对码、设备凭据及公钥。
- 通过条件：数据库仅保存 32 字节 code/credential hash，明文秘密各只在一次响应出现；设备凭据只能调用 storage-agent 路由，Session 不能替代 `QuorumAgent`，Agent 也不能调用账号或议事接口。一个委员会最多一个 `ACTIVE`/`DEGRADED` host；并发只有一个成功。转移前 A 有效，转移或撤销事务后 generation 单调递增，A/B 的旧请求统一返回 `STALE_STORAGE_LEASE` 且无状态变化。失效、已用、过期和失权 Chair 的码不能配对。离线只显示 `DEGRADED` 与最后在线时间，不暂停委员会；当前 generation 心跳恢复 `ACTIVE`。
- 自动化覆盖情况：当前 WSL 的 migration、共享状态、配对码/凭据格式、HTTP 独立认证和秘密不入日志测试已通过；真实 PostgreSQL 用例覆盖角色、哈希保存、一次性消费、并发转移、撤销 fencing、失权/过期、超时降级、恢复及故障回滚，未配置 `TEST_DATABASE_ADMIN_URL` 时明确 skip。真实 TLS、两设备、代理日志、浏览器一次性显示和长时间网络分区尚未执行。
- 当前状态：因无真实 PostgreSQL、自托管 TLS 实例和第二设备延期。
- 需要保存的证据：完整集成输出、migration 20 表/索引/触发器、脱敏 host/code/event/audit 查询、两个设备的 generation/响应时间线、断网期间议事结果、恢复事件、浏览器一次性显示截图和全链路秘密搜索结果。不得保存配对码、设备凭据、Session、CSRF token、私钥、本地路径或文件正文。

### SH-MAN-510 Agent manifest、任务 fencing 与流式内容

- 前置条件：真实 PostgreSQL 16；通过反向代理和 TLS 运行的自托管服务；一个含多文件、历史版本和墓碑的委员会；两个隔离 Agent 测试进程；可控制慢速、断流、超限、短写、长写、哈希错误、磁盘故障和进程终止；服务器卷及一个真实 S3 compatible 测试 provider。
- 操作步骤：在配对前创建、修改和删除文件，再配对 A 并分页拉取 manifest/task；在线时继续创建版本和墓碑，核对 sequence 与任务。重复领取同一 task，再用不同 request ID 并发领取；分别重复 complete/fail 和改用相反 outcome。对 `STORE_BLOB` 从服务器卷和 S3 下载并重算哈希；对测试 `UPLOAD_BLOB` 分别执行成功、断流、短写、长写、超限、哈希错误和磁盘写入失败。传输过程中把 host 转移给 B，再让 A 完成；让 stale claim 超过五分钟后由当前 host 重新领取。注入 event/audit 写入失败并检查事务回滚。确认长时间慢速传输期间点名、动议、投票和计时写入不被委员会行锁阻塞。
- 通过条件：manifest sequence 严格递增且墓碑覆盖旧版本；配对时每个文件只有最新状态任务，在线新版本/墓碑与文件事务原子出现。task 只可由相同 host/generation 领取；相同 request 精确重放，不同 terminal outcome 冲突，旧 claim 和旧 host 不能覆盖新状态。所有 blob 内容只通过匹配 task/claim 传输，provider 读取和 Agent 上传的实际大小/SHA-256 匹配；失败不产生完整状态或文件版本，部分暂存不可见。transfer 后 A 的完成返回 `STALE_STORAGE_LEASE`。慢速传输不长期占用委员会行锁；状态、事件和审计在故障下共同提交或回滚。
- 自动化覆盖情况：当前 WSL 的共享契约、migration 静态、HTTP 原始流、durable staging 和任务状态机测试已通过；真实 PostgreSQL 用例覆盖 manifest 回填、初始 task、claim 重放、幂等完成、相反 outcome 拒绝及 event/audit 回滚，未配置 `TEST_DATABASE_ADMIN_URL` 时明确 skip。真实 provider、TLS 反向代理、两个进程、网络分区、进程终止和数据库锁时间线尚未执行。
- 当前状态：因无真实 PostgreSQL、自托管 TLS 实例、第二设备和可控 provider 故障环境延期。
- 需要保存的证据：migration 21 表/触发器/约束、脱敏 manifest/task/event/audit 查询、sequence 与 generation 时间线、claim 重放响应、内容传输响应头与 SHA-256、失败矩阵、转移竞态结果、`pg_stat_activity`/锁等待记录和议事写入延迟。不得保存设备凭据、claim token、本地路径或文件正文。

### SH-MAN-511 `CHAIR_AGENT` provider、本地变化与恢复编排

- 前置条件：真实 PostgreSQL 16；TLS 自托管实例；Owner、Chair、member 和仅有 `SYSTEM_ADMIN` 的账号；两台隔离 Agent 测试进程；可断开 Agent 网络、转移 host、终止服务器进程并检查 durable staging；包含服务器卷/S3 现有文件、历史版本和墓碑的委员会。
- 操作步骤：由 member 和系统管理员尝试启用 Chair storage，再由 Owner/Chair 选择当前配对 host；暂停委员会后重试。Agent 在线和离线时分别从浏览器上传，刷新及重新登录后检查“等待主席电脑保存”，恢复 Agent 并重复 claim/complete；在完成事务写审计前注入失败并重试。分别上报本地新增、修改、重命名和删除，使用陈旧 manifest、陈旧 revision、同名文件及已删除 file ID 制造冲突；重复相同 request ID。传输本地内容时制造短写、长写、断流、哈希/大小错误和磁盘失败。保留浏览器待提交 upload 后把 A 转移为 B；另在 A 尚有未上传本地修改时转移。检查 B 的完整最新任务、既有文件同步状态、A 的迟到 complete/blob/local-change。清理过期 upload 和触发容量压力，确认唯一 staging 未删。完成 Chair 文件删除并同时运行服务器 maintenance worker。删除服务器 staging 后尝试下载仅存在主席电脑的文件，检查 Network、DOM、事件、审计和日志。
- 通过条件：只有 Owner/Chair 可绑定当前 generation host；暂停、陈旧 revision、已有 binding 和隐式系统管理员均拒绝。离线上传持久显示 `PENDING_HOST_COMMIT`，不暂停议事、不产生 file entry/version 且唯一 staging 不被清理；当前 Agent 完成后 task、upload、blob、file/version、manifest、事件、审计和幂等结果共同提交，重复完成不产生第二版本，故障回滚后可恢复。`local-changes` 只在最新 manifest/lease/revision 下接受；新增/修改先复验完整内容，重命名/删除用显式 revision。墓碑或并发状态优先并返回 `CHAIR_DECISION_REQUIRED`，冲突 durable 且不静默覆盖。转移后 A 全部写入被 fencing；B 获得浏览器 pending upload 和完整最新 manifest，文件从 `OUT_OF_SYNC` 收敛到 `SYNCED`；A 独有内容形成 `HOST_TRANSFERRED` 冲突。Chair 删除只由当前 Agent 完成，不被普通 provider cleanup 抢占。服务器有已验证 staging 时可授权下载；缓存移除后稳定返回暂不可用，浏览器从不获得 Agent 地址、凭据、本地路径或正文。
- 自动化覆盖情况：当前 WSL 的 migration 22 静态契约、202/pending 查询和 Chair binding HTTP、Agent local-change HTTP、任务 finalizer 顺序、前端持久 pending/sync 文案、TypeScript 与 mock 故障测试已通过。真实 PostgreSQL 用例覆盖浏览器 pending→host commit、staging 读取、事务回滚、host transfer 重排/fencing、本地内容发布、幂等重放、墓碑冲突和不复活；未配置 `TEST_DATABASE_ADMIN_URL` 时 13 项阶段 7 集成测试明确 skip。真实 PostgreSQL migration 执行、TLS、两设备、长时离线、进程终止、容量清理竞态、真实桌面目录和视觉/辅助功能尚未执行。
- 当前状态：因无真实 PostgreSQL、TLS 自托管实例、第二设备和桌面 Agent 延期。
- 需要保存的证据：migration 22 表/约束/触发器、binding/upload/change/conflict/task/manifest/file/blob/delete-job/event/audit 的脱敏查询；在线/离线/转移时间线；刷新前后页面和 sync 状态截图；staging inode/大小/SHA-256；故障矩阵、重复完成版本计数、maintenance 竞态与下载响应。不得保存设备凭据、claim token、Session、CSRF token、本地绝对路径或文件正文。

### SH-MAN-512 桌面 Agent 目录语义、进程中断与恢复

- 前置条件：Windows 11 x86-64 的 NTFS 与受支持 macOS 的 APFS 真机；各一份可执行 Agent 构建；TLS 自托管实例和真实 PostgreSQL；可用的 Chair 账号与测试委员会；可断网、终止进程、重启系统、制造磁盘满/只读和修改目录 ACL。测试根目录不得包含个人文件。
- 操作步骤：分别完成配对、选择空目录并同步含嵌套中文名的文件；创建、修改、移动和删除本地文件，验证 watcher 唤醒与周期全量扫描结果。尝试绝对路径、`..`、Windows 保留名、尾随点/空格、符号链接、junction、alias、硬链接、FIFO/设备文件和指向根目录外的父目录。下载期间制造短写、长写、断流、哈希错误、目标碰撞、并发本地编辑、只读目录和满盘；在临时文件写入、rename、task complete 和本地状态写入前后分别强制终止进程并重启。断网期间执行服务端删除和本地修改，再恢复；最后转移 host，确认旧进程因 stale lease 停止。检查共享目录元数据、私有配置权限、进程参数、控制台和日志。
- 通过条件：共享目录只有不含秘密和绝对根路径的 `.quorum-storage.json` 与内部临时目录；凭据、私钥和配对码不出现在目录元数据、进程参数或日志，私有配置仅当前用户可读。所有解析后的路径保持在根目录内，链接、非普通文件和平台保留路径 fail closed。服务端内容只有在完整大小/SHA-256 校验后原子出现；失败或断电最多留下可在重启时安全清理的内部临时文件，不把半文件识别为完整版本。本地编辑永不被服务端静默覆盖，墓碑先于扫描处理，冲突可恢复；同一 pending task 重启后重放而不产生重复版本。watcher 丢事件时周期扫描仍收敛。旧 lease 立即停止，临时网络故障退避重试且不泄露路径或秘密。
- 自动化覆盖情况：当前 WSL 中 `packages/storage-agent` 的测试覆盖 portable 路径、元数据 no-follow、原子状态故障、符号链接/硬链接、非普通目标、0600 配置、临时残片、短写/长写/哈希/断流、原子发布、本地编辑保护、墓碑优先、扫描/重命名、pending task 和 conflict 裁决重放、watcher 提示、未知协议 fail closed、stale lease、状态聚合和日志脱敏。Node/TypeScript 构建已通过。WSL 的 ext4/DrvFs 行为不能替代 NTFS/APFS、原生 watcher、Windows ACL、macOS 权限、原生进程终止或发布包验证。
- 当前状态：未签名 Windows/macOS Agent 构建已生成；因无 TLS/PostgreSQL 实例和两台真机，原生目录与恢复验证延期。
- 需要保存的证据：每个平台版本与文件系统、Agent 构建哈希/签名、目录树和权限的脱敏输出、任务/manifest/conflict 脱敏时间线、网络与进程终止矩阵、各故障后的文件 SHA-256/大小、重启恢复结果和秘密搜索结果。不得保存配对码、设备凭据、私钥、claim token、本地绝对路径或文件正文。

### SH-MAN-513 Agent 管理与冲突裁决

- 前置条件：真实 PostgreSQL 16；TLS 自托管实例；Owner、Chair、member 和仅有 `SYSTEM_ADMIN` 的账号；两台隔离 Chair Agent 主机；可注入数据库事务失败、Agent 断网、磁盘只读/满盘和进程终止；至少包含本地新增、修改、重命名、删除、同名和 host transfer 冲突。
- 操作步骤：逐角色打开文件页，创建初始配对码和转移码，检查当前主机、在线/离线状态、最后在线时间、关闭配对码和撤销操作。制造五类 conflict，分别选择保留服务端、采用本地和另存为新文件；名称冲突输入新名称。每次在裁决前并发修改 conflict、host generation 或 file revision，并重复相同幂等键及用不同 body 复用 key。对已删除文件尝试采用本地，对旧 host 内容尝试非丢弃裁决。分别在裁决事件、审计、Agent 本地状态保存、文件移动、下载/上传和 task 完成前注入失败并重启。运行 `quorum-storage-agent status`；搜索全链路中的设备秘密和绝对路径，并确认 Agent status/stdout/stderr 不含文件名、哈希或正文。最后只用键盘处理冲突，并检查窄屏、焦点和简体中文长名称。
- 通过条件：只有 Owner/Chair 能查看和执行主机管理与裁决；member 和系统管理员没有隐式权限。裁决绑定 conflict revision、当前 lease generation 和 file revision；陈旧请求返回稳定冲突并保留待裁决状态。相同请求精确重放，不同请求不能重复应用同一 conflict；状态、事件、审计、幂等响应和裁决 task 共同提交或回滚。墓碑不能被采用本地复活，旧 host 不能提交内容。Agent 重启后使用同一 request ID 收敛，裁决写失败保持可重试；force apply 不能覆盖无关本地文件，另存/改名目标经过 portable path 和内容复验。状态命令只输出 generation、manifest sequence 和聚合计数。浏览器和日志不出现设备秘密、本地绝对路径或文件正文。
- 自动化覆盖情况：migration 23 静态契约、共享类型、Agent HTTP client/runtime/filesystem/status、HTTP 认证分离、API client 和文件页交互测试已在 WSL 通过。真实 PostgreSQL 用例覆盖 Owner/Chair 权限、路径拒绝、revision/lease/file fencing、幂等重放、一次性裁决应用以及 event/audit 故障回滚；未配置 `TEST_DATABASE_ADMIN_URL` 时明确 skip。`pnpm test:self-host` 为 53 个文件、295 项通过，7 个 PostgreSQL 文件、63 项明确 skip；默认构建与自托管构建通过。真实 PostgreSQL、TLS、双设备、原生目录、浏览器视觉/键盘/辅助功能和故障注入尚未执行。
- 当前状态：因无真实 PostgreSQL、TLS 自托管实例、第二设备、原生桌面目录和浏览器验收环境延期。
- 需要保存的证据：migration 23 enum/列/约束/触发器与 application 表；脱敏 conflict/change/task/event/audit/idempotency 查询；三种裁决及五类原因时间线；故障前后 revision、task 和本地 SHA-256；角色、窄屏、焦点与键盘截图；status 和全链路秘密搜索结果。不得保存配对码、设备凭据、私钥、claim token、Session、CSRF token、本地绝对路径或正文。

### SH-MAN-514 Agent 发布、安装、升级、卸载与原生信任

- 前置条件：Windows 11 x86-64 NTFS 真机；Intel 与 Apple Silicon macOS APFS 真机或明确覆盖两个架构的等价设备；受保护的 Windows 代码签名证书存储、Developer ID Application keychain identity 和公证 profile；可访问发布渠道、TLS 自托管实例和测试委员会；发布用普通权限 OS 账号。不得使用个人文件目录测试。
- 操作步骤：在隔离目录各重复生成两次未签名包并比较 SHA-256；核对 `release-manifest.json`、`SHA256SUMS`、Agent/Node 版本、归档清单和权限。分别在原生 runner 执行签名脚本、重新归档、严格验签及 macOS 公证，检查 CI 日志和产物秘密。通过发布渠道下载，在新账号下验证 SmartScreen/Gatekeeper 和签名链，安装到版本化目录并配对。检查私有配置 ACL、共享目录元数据、命令行、进程环境和日志。配置当前用户 Task Scheduler/LaunchAgent，重启系统并等待同步。制造 pending upload 和 conflict recovery 后升级，使用原 config 启动并回退一次。撤销或转移主机后卸载；先只删除程序目录，再确认私有配置和用户存储目录仍在。最后按明确的数据处置决定单独删除私有配置，用户存储目录仍不得由卸载流程删除。
- 通过条件：同一源码、锁文件和运行时缓存产生逐字节相同归档；四个包只含 allowlist 文件，POSIX 入口/运行时可执行，版本、大小和 SHA-256 与 manifest 一致，不含仓库路径、凭据、私钥、配对码、claim token、正文、源码映射、声明文件或 `node_modules`。Windows Authenticode 与时间戳链通过，macOS Developer ID、hardened runtime 和公证通过；SmartScreen/Gatekeeper 不要求绕过安全策略。目标机无需 Node、pnpm 或仓库即可执行 `pair`、`start`、`status`。重启后只启动当前版本；升级保留设备身份、私有配置、共享目录元数据、pending upload 和 conflict recovery，回退不复制或复活文件。卸载默认不删除私有配置和用户选择的存储目录，也不留下仍运行的任务。
- 自动化覆盖情况：当前 WSL 已用伪运行时对四个平台验证固定 ZIP/tar.gz 字节、上游布局提取、路径逃逸拒绝、allowlist、版本、权限、秘密 canary、manifest 和重复构建；真实 Node.js 22.23.2 四个平台归档已按固定 SHA-256 下载并生成未签名包，发布验证器全部通过。Linux x86-64 包可在 WSL 运行。WSL 没有 Windows SDK/证书存储、NTFS ACL、SmartScreen、macOS `codesign`/Xcode keychain、APFS、Gatekeeper 或 Apple 公证服务，不能替代原生验签、安装、启动和系统重启证据。
- 当前状态：未签名跨平台包和 WSL 静态/运行验证已完成；签名、公证、原生安装与系统行为因缺少目标系统和凭据延期。
- 需要保存的证据：两次构建的 SHA-256 与 manifest、上游 Node 归档校验、完整归档清单、SignTool/codesign/notarytool 脱敏输出、签名链和时间戳、SmartScreen/Gatekeeper 截图、安装前后 ACL/权限、Task Scheduler/LaunchAgent 状态、重启与同步时间线、升级/回退前后聚合状态、卸载后的目录清单和全链路秘密搜索。不得保存证书私钥、密码、公证 token、Agent 凭据、配对码、私钥、claim token、本地绝对路径或正文。
