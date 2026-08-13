# 自托管迁移 Running Log

本文件是长任务的恢复点。每次完成验证、提交或改变下一步时更新；只记录已经发生的事实。

## 当前状态

- 更新时间：2026-08-13
- 分支：`self-host`
- 已确认基线：`da454ec stage 6.2: stream uploads to durable staging`
- 当前阶段：6.3 `SERVER_VOLUME` provider 已完成并单独提交；提交以当前 `git log` 为准。
- 当前工作：准备按阶段 6.4 交接实施 `S3_COMPATIBLE` provider。
- 下一步：复跑 6.3 针对性测试和 `pnpm build:self-host`，再实施阶段 6.4。

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
