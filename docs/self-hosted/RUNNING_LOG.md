# 自托管迁移 Running Log

本文件是长任务的恢复点。每次完成验证、提交或改变下一步时更新；只记录已经发生的事实。

## 当前状态

- 更新时间：2026-08-13
- 分支：`self-host`
- 已确认基线：`a7dd0fd stage 7.1: fence chair storage agents`
- 当前阶段：7.2 durable Agent task、manifest 与服务器内容边界已完成当前 WSL 可执行的验证，等待单独提交。
- 当前工作：migration 21、共享契约、任务状态机、独立 Agent HTTP 和流式内容校验已落地。
- 下一步：提交 7.2，然后按 `STAGE_7_3_HANDOFF_PROMPT.md` 实施 `CHAIR_AGENT` provider、本地变化和恢复编排。

## 已完成与验证

### 2026-08-13：恢复阶段 6.1 基线

- `git status --short --branch`：工作区干净；`self-host` 比 `origin/self-host` 多 1 个提交。
- 已阅读 `AGENTS.md`、`PROJECT_ARCHITECTURE.md` 和 `docs/self-hosted/` 的架构、数据/API、规则、存储、实施、基线、人工验收与阶段 6 交接文档。
- 阶段 6.1 针对性 Vitest：3 个文件、15 项测试通过。
- `pnpm build:self-host`：通过；Vite 仅报告既有的大分块警告。

## 当前环境限制

- 尚未提供 `TEST_DATABASE_ADMIN_URL`，真实 PostgreSQL 集成测试应明确 skip。
- Docker 持久卷、Caddy/TLS、S3 测试桶和多浏览器验证仍需按 `MANUAL_ACCEPTANCE.md` 上机执行。

### 2026-08-13：阶段 6.2 durable staging 与流式上传

- migration 14 增加 `file_uploads`、上传状态、预期/实际大小与 SHA-256、服务器暂存键、期限和失败摘要；schema compatibility 为 14。
- 同源 HTTP 增加 upload 创建和内容流路由；原始请求流逐块写入持久暂存区，不拼接完整文件。
- 服务端 UUID 决定暂存路径；内部路径拒绝绝对路径、点路径、符号链接逃逸和非普通文件。
- 成功内容只进入 `STAGED`，未调用 provider 提交，未创建 file entry、blob、version 或下载记录。
- `CREATED`、`RECEIVING` 和 `STAGED` 不进入普通过期清理；阶段 6.2 未实现清理 worker。
- 最终针对性 Vitest：9 个文件、40 项测试通过；1 个 PostgreSQL 文件的 6 项测试明确 skip。
- `pnpm test:self-host`：32 个文件、124 项测试通过；6 个 PostgreSQL 集成文件共 23 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、23 项测试因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- 当前 WSL 未检测到 `docker`、`psql` 或 `TEST_DATABASE_ADMIN_URL`；真实 PostgreSQL、持久卷、TLS、chunked 代理、进程终止恢复和内存曲线已写入 `MANUAL_ACCEPTANCE.md`。
- `git diff --check`：通过。

## 提交记录

- `4351291`：阶段 6.1 文件元数据、版本、存储绑定和墓碑。
- `da454ec`：阶段 6.2 durable staging 与流式上传。
- `1119c2a`：阶段 6.3 `SERVER_VOLUME` provider。
- `de214c1`：阶段 6.4 `S3_COMPATIBLE` provider。
- `3fe305d`：阶段 6.5 文件审核、授权下载和永久删除任务。
- `c30aafc`：阶段 6.6 provider 切换与失败回退。
- `f6e82d7`：阶段 6.7 磁盘阈值和后台清理。
- `c722f95`：阶段 6.8 自托管文件 UI 与阶段 6 收尾。
- `a7dd0fd`：阶段 7.1 Agent 配对、设备身份与单主机 fencing。

### 2026-08-13：阶段 6.3 SERVER_VOLUME provider

- migration 15 为 upload 保存服务器生成的 provider blob/key 和已提交 blob/entry/version 关联；schema compatibility 为 15。
- `POST /api/v1/file-uploads/:id/commit` 只接收完整 `STAGED` upload，并重新检查创建者、活动委员会和活动 `SERVER_VOLUME` binding。
- 暂存内容流式复制到 0600 provider 临时文件，经文件 `fsync`、无覆盖原子发布、目录同步和最终重读校验后才进入 PostgreSQL 发布事务。
- provider 最终路径只由 blob UUID 派生；符号链接、硬链接和非普通文件被拒绝。
- upload、blob、file entry/version、事件、审计和幂等响应在同一事务提交。数据库失败保留暂存和最终 provider 字节，同一 upload 重试复用原 blob 目标。
- 针对性 Vitest：6 个文件、36 项测试通过；1 个 PostgreSQL 文件的 9 项测试因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。随后增加资格撤销集成用例，集成文件现有 10 项明确 skip。
- `@quorum/contracts` 与 `@quorum/server` TypeScript build：通过。
- `pnpm test:self-host`：33 个文件、132 项测试通过；6 个 PostgreSQL 集成文件共 27 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、27 项测试因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 仍未提供真实 PostgreSQL、Docker 持久卷或 TLS 浏览器；断电、满盘、重启、挂载卷和代理证据记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-503。
- 阶段 6.3 已单独提交；提交以当前 `git log` 为准。

### 2026-08-13：阶段 6.4 S3_COMPATIBLE provider

- migration 16 增加实例级 S3 provider 配置、凭据密文字段、key version 和 binding 外键；schema compatibility 为 16。
- 凭据使用显式 master key 的 AES-256-GCM，AAD 绑定配置 ID 与 key version。错误 key、密文篡改和跨配置重放被拒绝。
- 系统管理员管理配置；Chair 只能绑定活动配置。配置响应、事件和审计不包含凭据。
- endpoint 只接受 HTTPS，配置和 DNS 解析后均执行 SSRF 检查；连接固定到已验证地址。私网目标只能由系统管理员显式允许。
- SigV4 适配器从 durable staging 流式 PUT；object key 只由管理员 prefix 与 blob UUID 派生，PUT 后 GET 重算大小和 SHA-256。
- provider 或数据库故障保留暂存；同一 upload 重试复用 blob/object key。阶段 6.4 不开放下载或运行删除任务。
- 最终针对性 Vitest：9 个文件、51 项测试通过；1 个 PostgreSQL 文件 12 项明确 skip。SigV4 与 AWS 官方 GET Object 测试向量精确匹配；contracts 与 server build 通过。
- `pnpm test:self-host`：36 个文件、152 项测试通过；6 个 PostgreSQL 集成文件共 29 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、29 项测试因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 没有真实 PostgreSQL、S3 compatible 测试桶、可控 DNS/TLS 或浏览器；相关验证与取证要求记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-504。
- 阶段 6.4 已单独提交；提交以当前 `git log` 为准。

### 2026-08-13：阶段 6.5 文件审核、发布、下载和永久删除

- migration 17 增加审核时间/发布 actor、数据库审核状态机和按 blob 唯一的 durable delete job；schema compatibility 为 17。
- 同源 HTTP 增加文件列表、详情、下载、提交审核、发布和逻辑删除。PUBLIC 只看到公开委员会的已发布文件；member、Chair 和 Owner 可读取未删除文件。
- 审核、发布和删除继续执行 Session、Origin、CSRF、revision 与幂等键；状态、事件、审计和幂等响应同事务提交，暂停委员会拒绝状态变化。
- 下载在发送响应头前预检 provider 大小与 SHA-256，强制安全附件头；HTML、XML、JavaScript、XHTML 与 SVG 返回 `application/octet-stream`，恶意文件名和 MIME 不能注入响应头。
- 逻辑删除立即不可见并为所有不可变版本创建 provider delete job。SERVER_VOLUME 与 S3 删除均幂等；失败退避重试，超过五分钟的 `IN_PROGRESS` claim 可恢复。阶段 6.7 的常驻 worker 尚未启动。
- 最终针对性 Vitest：7 个文件、47 项通过；2 个 PostgreSQL 文件、20 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm test:self-host`：37 个文件、167 项通过；6 个 PostgreSQL 集成文件、36 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；contracts、前端、rule-schema 和 server 均构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、36 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 仍没有真实 PostgreSQL、持久卷、S3 compatible 测试桶或 TLS 浏览器；角色矩阵、危险类型浏览器隔离、真实 provider 下载/删除、进程终止和 stale claim 恢复记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-505。
- 阶段 6.5 已单独提交；提交以当前 `git log` 为准。

### 2026-08-13：阶段 6.6 provider 切换与失败回退

- migration 18 增加 provider migration、逐内容 copy item、同内容跨 binding 已验证副本、manifest revision、claim token 和 S3 配置 revision 验证状态；schema compatibility 为 18。
- Owner 或 Chair 可创建、重试、确认和取消切换；同源 HTTP 保持 Session、Origin、CSRF、revision、幂等键和暂停状态边界，系统管理员不自动获得 Chair 权限。
- 目标 binding 在复制期保持 `MIGRATING`，旧 binding 继续为活动读取来源。常驻 worker 从源 provider 校验读取，经服务器生成的 durable staging key 流式复制，再从目标重读校验大小和 SHA-256。
- `file_versions.blob_id` 保持不可变；`file_blob_copies` 保存逻辑内容在目标 binding 上的物理副本。只有 manifest 未变且所有历史版本目标副本再次验证，确认事务才同时退役源 binding、激活目标 binding、更新委员会并完成 migration。
- 新版本和逻辑删除递增 manifest revision 并使进行中的 migration 以 `MANIFEST_CHANGED` 失败；retry 补齐新内容并取消已删除内容。provider/数据库故障、stale claim 和取消都保持源 binding 生效；取消和晚到目标写入进入 durable delete job。
- S3 迁移目标必须是活动且当前 revision 已验证的配置；配置更新会清除验证状态。已停用 S3 配置仍可读取和删除已有 blob。
- 阶段 6.5 基线复跑：针对性 Vitest 47 项通过、20 项 PostgreSQL 用例明确 skip；`pnpm build:self-host` 通过，仅有既有 Vite 大分块警告。
- 最终针对性 Vitest：5 个文件、34 项通过；1 个 PostgreSQL 文件、26 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm test:self-host`：38 个文件、173 项通过；6 个 PostgreSQL 集成文件、43 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；contracts、前端、rule-schema 和 server 均构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、43 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 仍没有真实 PostgreSQL、持久卷、S3 compatible 测试桶、多实例或 TLS 浏览器；双向迁移、真实 provider 故障、进程终止、stale claim 和确认前目标损坏记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-506。
- 阶段 6.6 已完成当前 WSL 可执行的验证；单独提交后直接进入 6.7。

### 2026-08-13：阶段 6.7 磁盘阈值和后台清理

- 阶段 6.6 基线复跑：针对性 Vitest 31 项通过、26 项 PostgreSQL 用例明确 skip；`pnpm build:self-host` 通过，仅有既有 Vite 大分块警告。
- migration 19 为 upload 和 provider migration staging 增加 cleanup attempts、next attempt、claim token、stale claim、失败摘要与删除时间，并新增不可修改的 `storage_cleanup_audit`；schema compatibility 为 19。
- `StorageCapacityMonitor` 对实际 `QUORUM_STORAGE_PATH` 执行 `statfs`。默认 80% warning、90% critical，可用有序整数百分比环境变量调整；状态转换写结构化日志且不记录存储路径。
- critical 或容量未知阻止新 upload 与新内容写入，并暂停 provider migration copy claim；已有幂等响应仍可重放。下载、议事命令、blob delete 和 staging cleanup 不受临界阈值阻断。
- readiness 在数据库/migration、必要目录或容量采样不可用时失败；warning/critical 仍返回 200 并包含使用率及可用字节，避免把仍可读实例从服务中摘除。Caddy 已转发只含固定聚合值的 Prometheus `/metrics`。
- 常驻 maintenance worker 优先运行阶段 6.5 blob delete job，再清理严格符合条件的 upload/migration staging。`STAGED`、活动或待重试 copy、唯一副本和退休源 provider 副本不会被期限、LRU 或压力删除。
- 清理使用 `FOR UPDATE SKIP LOCKED`、claim token、五分钟 stale 回收和指数退避。unlink/provider delete 后进程或数据库失败可通过“目标不存在”幂等收敛；成功和失败均追加维护审计。
- 最终针对性 Vitest：9 个文件、60 项通过；1 个 PostgreSQL 文件、30 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm test:self-host`：40 个文件、188 项通过；6 个 PostgreSQL 集成文件、47 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- 默认 `pnpm build` 与 `pnpm build:self-host` 均通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、47 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 没有真实 PostgreSQL、可控持久卷、S3、多实例、只读/满盘或进程终止环境；相关验证与证据要求记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-507。
- 阶段 6.7 已完成当前 WSL 可执行的验证；单独提交后直接进入 6.8。

### 2026-08-13：阶段 6.8 自托管文件 UI 与阶段收尾

- 阶段 6.7 已单独提交为 `f6e82d7`，提交前工作区差异检查通过。
- 6.7 基线复跑：30 项针对性测试通过；30 项 PostgreSQL 用例因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm build:self-host`：通过；Vite 仅报告既有的大分块警告。
- 增加 Chair/Owner 可读的 binding 状态和 `SERVER_VOLUME` 初始化 HTTP；系统管理员不因实例角色自动获得委员会 Chair 权限。初始 binding 可由 Owner 或 Chair 创建，未改变 provider 数据模型。
- 浏览器以固定 1 MiB `Blob.slice()` 增量计算 SHA-256，并用 XHR 直接发送原始 `File`、报告实际进度和支持取消；重试保留所选文件与稳定幂等键，不在内存中复制完整文件。
- 自托管工作区增加文件页：PUBLIC 只能下载已发布文件；member 可上传；文件所有者可提交审核和删除；Chair/Owner 可审核、发布、删除、配置 binding 和控制 provider migration。失败后刷新权威状态，409 不由客户端覆盖。
- 下载只使用同源 attachment URL，不把用户文件送入 DOM、iframe、object、data URL 或预览组件。永久删除使用明确且不可逆的短确认文案。
- 系统管理员的独立存储配置页可创建、更新、停用和验证 S3 配置；服务端不会回传凭据，浏览器不预填或记录密钥，轮换必须同时提供两项新凭据。
- 最终针对性验证：7 个测试文件、36 项测试通过；1 个 PostgreSQL 文件、31 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip；TypeScript、server build 和 `git diff --check` 通过。
- `pnpm test:self-host`：43 个文件、208 项通过；6 个 PostgreSQL 集成文件、48 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- 默认 `pnpm build` 与 `pnpm build:self-host` 均通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、48 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- Cypress 13.11.0 在可写临时缓存和沙箱外通过二进制校验；`pnpm test:e2e` 使用 Firebase emulators 与 Electron 118 完成既有 4 个 spec、22 项全通过。该套件验证 Firebase 运行时回归，不替代需要 PostgreSQL、真实 provider 和 TLS 的自托管浏览器验收。
- 当前 WSL 仍未提供真实 PostgreSQL、Docker 持久卷、S3 compatible 测试桶或 TLS 入口；角色矩阵、真实大文件流、provider 故障/迁移、危险类型下载隔离与可访问性证据记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-508。
- `git diff --check`：通过。阶段 6.8 完成后直接进入阶段 7.1。

### 2026-08-13：阶段 7.1 Agent 身份与 fencing

- 阶段 6.8 已单独提交为 `c722f95`；提交后工作区干净。
- 6.8 基线复跑：6 个测试文件、34 项通过；1 个 PostgreSQL 文件、31 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- 7.1 只实施短期一次性配对、设备凭据、单活动主机、lease generation、撤销/转移、心跳和离线降级；durable task、manifest、目录同步和桌面发布包留给后续 7.x。
- migration 20 增加只保存哈希的 `storage_pairing_codes`、设备公钥/凭据哈希、历史 `storage_hosts`、委员会单调 generation、单当前 host 部分唯一索引和不可逆生命周期触发器；schema compatibility 为 20。
- 配对码来自 16 个随机字节，默认 10 分钟有效；设备凭据含服务器 device UUID 和 32 个随机字节。两种明文秘密只返回一次，不写数据库、事件、审计或日志。
- Owner/Chair 通过 Session、Origin、CSRF 和 revision 创建配对、查看 host、撤销或发起转移；`SYSTEM_ADMIN` 不自动获得权限。Agent 配对不接受 Session，后续只接受独立 `QuorumAgent` authorization scheme。
- `INITIAL` 要求无当前 host；`TRANSFER` 在新设备实际配对前保持旧 host 有效。成功配对、转移或撤销在委员会行锁事务中递增 generation；旧凭据和迟到 generation 返回 `STALE_STORAGE_LEASE`。
- 所有并发路径统一按委员会、配对码/host 的顺序加锁。部分唯一索引再保证一个委员会最多一个 `ACTIVE`/`DEGRADED` host；配对消费、host 状态、事件和审计同事务提交。
- heartbeat 只更新固定状态和最后在线时间。默认 45 秒超时的常驻 monitor 把 host 标为 `DEGRADED` 并发送 Chair 事件，不改变委员会状态；当前 generation 心跳恢复 `ACTIVE`。
- 最终针对性 Vitest：5 个文件、28 项通过；1 个 PostgreSQL 文件、6 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。contracts 与 server build、`git diff --check` 通过。
- `pnpm test:self-host`：46 个文件、215 项通过；7 个 PostgreSQL 集成文件、54 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- 默认 `pnpm build` 与 `pnpm build:self-host` 均通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：7 个文件、54 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- 当前 WSL 没有真实 PostgreSQL、自托管 TLS 实例或第二设备；真实并发配对、两设备转移、网络分区、代理/浏览器秘密泄漏搜索和长时间离线恢复记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-509。
- `git diff --check`：通过。阶段 7.1 完成后直接进入 7.2。

### 2026-08-13：阶段 7.2 Agent task 与 manifest

- 阶段 7.1 已单独提交为 `a7dd0fd`；提交后工作区干净。
- 7.1 基线复跑：5 个测试文件、28 项通过；1 个 PostgreSQL 文件、6 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm build:self-host`：通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- 7.2 只实施 durable task、manifest sequence、claim/complete/fail fencing 和服务器流式内容边界；桌面 Agent、目录监测、完整扫描与发布包留给后续 7.x。
- migration 21 预留 `CHAIR_AGENT` provider enum/约束，并增加按委员会严格递增的追加式 manifest、按 host/generation 固定的 durable task、claim/terminal request、内容暂存状态和不可变身份约束；schema compatibility 为 21。binding 命令和提交仍留到 7.3。
- 文件版本和墓碑由数据库触发器在原事务追加 manifest 并为当前 host 创建 `STORE_BLOB`/`DELETE_FILE`；新 host 配对时按每个文件最新 manifest 补建完整任务集。
- Agent manifest/task 支持游标分页；claim、complete 和 fail 复核 credential、委员会/host/task generation、file revision 和 claim token。相同 request 精确重放，不同 terminal outcome 冲突。
- `GET /api/v1/storage-agent/blobs/:id` 只为匹配的 `STORE_BLOB` claim 流式返回已复验 provider 内容；`POST /api/v1/storage-agent/blobs` 只为匹配的 `UPLOAD_BLOB` claim 流式写入服务器内部 durable staging 并校验大小与 SHA-256。
- 网络传输位于短数据库事务之外，完成时再次复核当前 lease；慢速 Agent 不长期持有委员会行锁，转移后的旧 host 不能提交完成状态。
- 阶段 7.2 尚未创建生产 `UPLOAD_BLOB` task，也未实施 `local-changes`、`CHAIR_AGENT` binding、本地目录扫描、冲突处理、桌面程序或 task staging cleanup。
- 最终针对性测试：4 个文件、10 项通过；1 个 PostgreSQL 文件、9 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。另有 migration/tokens 针对性测试一并通过。
- `pnpm test:self-host`：47 个文件、222 项通过；7 个 PostgreSQL 集成文件、57 项明确 skip。仅有既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host` 与 `pnpm build`：通过；Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：7 个文件、57 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 未提供真实 PostgreSQL、自托管 TLS、真实 provider、第二设备或可控网络/进程终止环境；实机步骤和证据要求记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-510。
