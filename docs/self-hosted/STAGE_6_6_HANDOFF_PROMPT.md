# 阶段 6.6 交接 Prompt

```text
继续 Quorum 自托管迁移，只实施阶段 6.6：provider 切换与失败回退。

仓库：/home/makoto/code/Quorum
分支：self-host
基线：阶段 6.5 提交后的 HEAD。开始前用 git log、git status 和 docs/self-hosted/RUNNING_LOG.md 核对，不假定工作区干净。

开始前：
1. 阅读 AGENTS.md、PROJECT_ARCHITECTURE.md，以及 docs/self-hosted/ 下的 ARCHITECTURE.md、DATA_API_SPEC.md、STORAGE_AGENT_SPEC.md、IMPLEMENTATION_PLAN.md 和 MANUAL_ACCEPTANCE.md。
2. 所有项目命令前执行 source scripts/wsl-env.sh。
3. 复跑阶段 6.5 针对性测试和 pnpm build:self-host。

只实施 6.6：
- 用新 migration 建立 durable provider migration、逐 blob copy item、状态、attempt、claim/lease、失败摘要、源/目标 binding、manifest revision 和确认边界。
- 只有委员会 Owner 或 Chair 可以创建、重试、确认或取消切换；actor 从 Session 推导，保持 Origin、CSRF、revision、Idempotency-Key、请求上限和稳定错误码。
- 目标 binding 在复制期间为 MIGRATING；源 binding 与 committees.active_storage_binding_id 保持 ACTIVE，列表、详情和下载继续从每个现有 blob 保存的源 binding 读取。
- worker 从源 provider 校验读取并流式复制到目标 provider；目标 key 只由目标 binding 和 blob UUID 派生，不使用用户文件名，不加载完整文件到内存。
- 每个目标 blob 必须重新校验实际大小和 SHA-256。全部当前、未删除 blob 的 copy item 完成后，再重新锁定委员会、migration、源/目标 binding 和 manifest revision。
- 只有 manifest 未变化且全部目标 blob 校验完成时，才在一个 PostgreSQL 事务中切换 active binding、为当前版本建立目标 blob 关联、退役源 binding、完成 migration，并写事件、审计和幂等响应。
- manifest 在复制期间变化时不得部分切换；记录稳定冲突并允许重新规划缺失项或安全重试。
- provider、数据库或进程故障保留源 binding 生效。copy item 失败可退避重试；超时 claim 可回收；同一任务与相同幂等键不得创建重复目标 blob 或部分 metadata。
- 取消只删除确认不再是唯一有效副本的目标副本；不得删除源 provider 内容、墓碑或阶段 6.5 delete job。
- 保持已停用 S3 配置对已有 blob 的读取/删除能力，但新目标只能使用活动且已验证的 provider 配置。
- 委员会 PAUSED、ARCHIVED 或 DELETING 时拒绝创建和确认切换；安全读取和已排队任务的保守停止/恢复语义必须明确。
- 不实施阶段 6.7 磁盘阈值/常驻清理调度、阶段 6.8 文件 UI、Chair Local Agent、归档或 Firebase 移除。

需要测试：
- 复制期间和任一失败后，旧 provider 仍是活动读取来源。
- SERVER_VOLUME→S3、S3→SERVER_VOLUME 以及同类型不同配置的复制使用目标生成 key，逐块复制并重新校验大小/SHA-256。
- 短写、长写、哈希不匹配、源损坏、目标故障、数据库故障和进程中断均不产生部分切换。
- manifest/revision 变化、并发切换、陈旧确认和错误角色被拒绝；SYSTEM_ADMIN 不自动获得 Chair 权限。
- 重复创建、claim、完成、确认和取消保持幂等；stale claim 可恢复。
- 状态、binding、blob 关联、事件、审计和幂等记录在故障下原子一致。
- 未配置真实 PostgreSQL 时集成测试明确 skip；真实双 provider、持久卷和网络故障步骤写入 MANUAL_ACCEPTANCE.md。

完成后运行：
- 针对性 Vitest
- pnpm test:self-host
- pnpm build:self-host
- pnpm test:self-host:integration
- git diff --check

更新 PROJECT_ARCHITECTURE.md、相关 README、DATA_API_SPEC.md、STORAGE_AGENT_SPEC.md、IMPLEMENTATION_PLAN.md、MANUAL_ACCEPTANCE.md 和 RUNNING_LOG.md，只描述已经落地的事实。将 6.6 单独提交，然后继续阶段 6.7。
```
