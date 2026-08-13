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
- 通过条件：两次 migration 均成功；当前 schema compatibility 为 4，且 12 个阶段 3 核心表继续存在；同一用户的第二个活动席位被拒绝；已发布规则版本和审计记录不能更新或删除；测试数据库最终清理。
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
- 通过条件：schema compatibility 为 4；阶段 4 表、外键、唯一索引和追加式触发器均生效；并发写只有一个符合 revision 的请求成功；临时数据库最终清理。
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
- 通过条件：PUBLIC 匿名页面可读取公开字段；PRIVATE 未授权访问统一 404；公开响应不含 owner、用户 ID、actor、正文、主席内部回应或审计；member/Chair/Owner 字段逐级增加；重新聚焦可取得最新快照；网络中没有 Firebase、`/events`、EventSource 或轮询请求。
- 自动化覆盖情况：快照过滤、HTTP 匿名路由、前端 focus revalidation 和静态边界已有测试；真实深层 SPA fallback、TLS、多浏览器和网络面板需人工确认。
- 当前状态：因无服务器延期。
- 需要保存的证据：各 audience 脱敏响应差异、浏览器截图、网络 HAR、深层路由刷新结果和代理日志。
