# 阶段 6.7 交接 Prompt

```text
继续 Quorum 自托管迁移，只实施阶段 6.7：磁盘阈值和后台清理。

仓库：/home/makoto/code/Quorum
分支：self-host
基线：阶段 6.6 提交后的 HEAD。开始前用 git log、git status 和 docs/self-hosted/RUNNING_LOG.md 核对，不假定工作区干净。

开始前：
1. 阅读 AGENTS.md、PROJECT_ARCHITECTURE.md，以及 docs/self-hosted/ 下的 ARCHITECTURE.md、DATA_API_SPEC.md、STORAGE_AGENT_SPEC.md、IMPLEMENTATION_PLAN.md 和 MANUAL_ACCEPTANCE.md。
2. 所有项目命令前执行 source scripts/wsl-env.sh。
3. 复跑阶段 6.6 针对性测试和 pnpm build:self-host。

只实施 6.7：
- 为服务器卷和 durable staging 建立可配置的容量采样与保护边界。默认使用率达到 80% 记录告警，达到 90% 拒绝新的内容上传和 provider migration copy；下载、议事操作、删除与恢复清理继续可用。
- 容量判断使用实际挂载点，不使用进程当前目录；采样失败或必要存储不可写时 readiness 明确失败，不把未知状态当作有空间。
- 增加常驻、可停止的 cleanup worker，运行阶段 6.5 已有 durable blob delete job，并清理符合条件的 upload staging 与 provider migration staging。
- upload staging 只有 `COMMITTED`、`CANCELLED` 或失败且期限已过时可删；`CREATED`、`RECEIVING`、`STAGED` 和仍可能是唯一有效副本的内容不得因 LRU、期限或容量压力删除。
- provider migration staging 只有 item 已完成、取消，或失败后已无可恢复价值且满足明确期限时可删；活动 claim、待重试 copy 和取消后尚未登记 durable delete job 的目标不得提前删除。
- worker 使用 PostgreSQL claim token、超时回收、退避和幂等完成；多个应用实例可协作，旧 worker 不得覆盖新 claim。数据库完成事务失败时允许安全重试。
- 删除物理内容前再次证明其不再是活动 binding 的唯一有效副本；退休 provider 副本的容量回收必须保守，不因压力自动破坏回退能力。
- 暴露最小必要的 readiness、指标和结构化日志，包含使用率、阈值状态、队列深度、成功/失败计数和稳定 failure code；不得泄漏路径中的秘密、文件名、内容或 S3 凭据。
- 容量告警和后台失败不得暂停委员会；只有新内容写入被保护性拒绝。保持 Session、Origin、CSRF、幂等、revision 与现有授权边界。
- 不实施阶段 6.8 文件 UI、Chair Local Agent、归档、备份或 Firebase 移除。

需要测试：
- 79%/80%/89%/90% 阈值边界，采样失败、只读卷、满盘和恢复；90% 时上传/copy 拒绝但下载、议事和清理可用。
- 只有允许状态的 upload/migration staging 被删除；未提交唯一副本、活动 claim、待重试和仍需回退的副本保留。
- SERVER_VOLUME 与 S3 delete job 成功、不存在对象、短暂失败、永久失败、数据库故障、进程终止和 stale claim 均安全收敛。
- 多实例不会重复破坏状态；同一 job 重复执行幂等，旧 claim 完成被 fencing。
- readiness、指标、事件/审计和结构化日志反映真实状态且不泄漏敏感信息。
- 未配置真实 PostgreSQL 时集成测试明确 skip；真实挂载卷、S3、满盘、只读、进程终止和多实例步骤写入 MANUAL_ACCEPTANCE.md。

完成后运行：
- 针对性 Vitest
- pnpm test:self-host
- pnpm build:self-host
- pnpm test:self-host:integration
- git diff --check

更新 PROJECT_ARCHITECTURE.md、相关 README、DATA_API_SPEC.md、STORAGE_AGENT_SPEC.md、IMPLEMENTATION_PLAN.md、MANUAL_ACCEPTANCE.md 和 RUNNING_LOG.md，只描述已经落地的事实。将 6.7 单独提交，然后继续阶段 6.8。
```
