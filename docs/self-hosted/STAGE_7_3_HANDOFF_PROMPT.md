# 阶段 7.3 交接 Prompt

继续 Quorum 自托管迁移，只实施阶段 7.3：`CHAIR_AGENT` provider 与恢复编排。

仓库：`/home/makoto/code/Quorum`
分支：`self-host`
基线：阶段 7.2 的单独提交，以 `git log -1` 为准。

开始前：

1. 用 `git log` 和 `git status` 核对基线，不假定工作区干净。
2. 阅读 `AGENTS.md`、`PROJECT_ARCHITECTURE.md`、`docs/self-hosted/RUNNING_LOG.md`，以及本目录的架构、数据/API、存储 Agent、实施计划和人工验收文档。
3. 所有项目命令前执行 `source scripts/wsl-env.sh`。
4. 复跑阶段 7.2 的 manifest/task/HTTP 针对性测试和 `pnpm build:self-host`。

只实施 7.3：

- 用新 migration 增加 `CHAIR_AGENT` storage binding、文件同步状态、服务器 upload 到 host 的 `PENDING_HOST_COMMIT` 状态和本地变化/冲突所需的 durable 元数据；不改写既有 file version。
- Chair/Owner 可以选择当前已配对 host 作为委员会 provider；`SYSTEM_ADMIN` 不自动获得 Chair 权限。暂停委员会时拒绝会改变文件状态的命令。
- 浏览器 upload 在服务器 durable staging 完整校验后创建固定 generation 的 `STORE_BLOB` task；Agent 完成并回报内容校验后，单一 PostgreSQL 事务发布 blob、file entry/version、manifest、事件、审计和幂等响应。
- Agent 离线时保持 `PENDING_HOST_COMMIT`，不删除唯一 staging 副本，不暂停议事；恢复后继续相同 task/blob/staging key。
- 实现 `POST /api/v1/storage-agent/local-changes`：先读取完整最新 manifest/墓碑，再接受新增、修改、删除或重命名意图。每项必须携带 lease generation、file revision、大小和 SHA-256；墓碑和较新 revision 优先，不能复活删除文件。
- 本地新增/修改先创建服务器生成路径的 `UPLOAD_BLOB` task，经阶段 7.2 流式内容边界完整校验后才可发布新版本。重命名和删除必须使用显式 revision 命令；冲突保存 durable 记录并返回 `CHAIR_DECISION_REQUIRED`，不得静默覆盖任一副本。
- host 转移或撤销 fencing 所有旧 task 完成、本地变化和内容提交；为新 host 重新规划完整最新 manifest，旧 generation 的 staging/task 进入后续可证明安全的清理范围。
- 下载仅在服务器有已验证暂存/缓存副本时可用；仅存在 Chair 电脑的内容返回稳定的暂不可用状态，不让浏览器直连 Agent。
- 不实施桌面文件系统 watcher/扫描器、原子本地落盘、Windows/macOS 发布包、归档/备份、委员会永久删除或 Firebase 移除。

需要测试：

- online/offline 浏览器上传分别收敛到 `PENDING_HOST_COMMIT`/已提交状态，恢复不创建重复版本；唯一暂存副本不会被期限或容量清理。
- `local-changes` 的新增、修改、重命名和删除均检查最新 manifest、墓碑、revision、generation、角色和委员会状态。
- 删除墓碑阻止离线旧文件复活；并发服务器/本地修改形成显式冲突，不静默覆盖。
- 旧 host 在转移后不能完成 task、上传内容或提交 local change；新 host 获得完整最新任务集。
- 短写、长写、断流、哈希/大小错误、provider/数据库故障均不产生部分 file version；状态、manifest、task、事件、审计和幂等记录原子提交或回滚。
- 下载不会绕过服务器授权，也不会把 Agent 地址、凭据、本地路径或正文暴露给浏览器、事件、审计或日志。
- 未配置真实 PostgreSQL 时集成测试必须明确 skip。

完成后运行：

- 针对性 Vitest
- `pnpm test:self-host`
- `pnpm build:self-host`
- `pnpm build`
- `pnpm test:self-host:integration`
- `git diff --check`

更新 `PROJECT_ARCHITECTURE.md`、相关 README、`DATA_API_SPEC.md`、`STORAGE_AGENT_SPEC.md`、`IMPLEMENTATION_PLAN.md`、`MANUAL_ACCEPTANCE.md` 和 `RUNNING_LOG.md`，只描述已经落地的事实。把 7.3 单独提交，并为下一阶段撰写新的交接 Prompt；提交后继续实施后续阶段。
