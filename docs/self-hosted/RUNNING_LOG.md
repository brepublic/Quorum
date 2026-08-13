# 自托管迁移 Running Log

本文件是长任务的恢复点。每次完成验证、提交或改变下一步时更新；只记录已经发生的事实。

## 当前状态

- 更新时间：2026-08-13
- 分支：`self-host`
- 已确认基线：`3fe305d stage 6.5: publish and delete stored files`
- 当前阶段：6.6 provider 切换与失败回退已实现并通过当前 WSL 可执行的验证。
- 当前工作：单独提交阶段 6.6。
- 下一步：按 `STAGE_6_7_HANDOFF_PROMPT.md` 复跑 6.6 基线，然后实施磁盘阈值和后台清理。

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
- 阶段 6.5 文件审核、授权下载和永久删除任务：提交以当前 `git log` 为准。
- 阶段 6.6 provider 切换与失败回退：提交以当前 `git log` 为准。

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
