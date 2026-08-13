# 阶段 6.3 交接 Prompt

```text
继续 Quorum 自托管迁移，只实施阶段 6.3：SERVER_VOLUME provider。

仓库：/home/makoto/code/Quorum
分支：self-host
基线：阶段 6.2 提交后的 HEAD。开始前用 git log、git status 和 docs/self-hosted/RUNNING_LOG.md 核对，不假定工作区干净。

开始前：
1. 阅读 AGENTS.md、PROJECT_ARCHITECTURE.md，以及 docs/self-hosted/ 下的 ARCHITECTURE.md、DATA_API_SPEC.md、STORAGE_AGENT_SPEC.md、IMPLEMENTATION_PLAN.md、MANUAL_ACCEPTANCE.md 和 RUNNING_LOG.md。
2. 所有项目命令前执行 source scripts/wsl-env.sh。
3. 复跑阶段 6.2 针对性测试和 pnpm build:self-host。

只实施 6.3：
- 只处理已经完整校验且状态为 STAGED 的 upload；从 Session 推导 actor，并重新检查委员会、活动 binding、权限和暂停状态。
- SERVER_VOLUME 最终路径只能由服务器生成的 blob UUID 派生；用户文件名、logical name 和 media type 不得参与磁盘路径。
- 从 durable staging 流式复制到同一持久卷的临时 provider 文件，执行单文件和请求上限；fsync 后原子提交，再从最终目标重新读取并校验实际大小和 SHA-256。
- 拒绝绝对路径、`.`、`..`、反斜杠、符号链接逃逸、硬链接替换和非普通文件；临时文件与最终文件权限必须最小化。
- provider 完整提交并重新校验后，才调用或重构 Stage6StorageService.recordProviderCommit 的内部事务边界，创建 file_blob、file_version 和可见 file_entry。
- upload 的 COMMITTED 状态、file/blob/version、委员会事件、审计和幂等记录必须原子提交；不得先发布文件再补 upload 状态。
- provider 或数据库失败时保留仍有效的 STAGED 暂存副本以便重试，不创建无内容或部分内容记录；重复相同幂等键不得产生第二个 blob/version。
- SERVER_VOLUME 最终内容一旦是已发布版本的唯一 provider 副本，不得由暂存清理或 LRU 删除。
- 实现安全读取原语；如本小阶段开放下载响应，Content-Disposition 必须安全编码并强制危险 HTML/SVG 等类型下载，禁止同源内联执行。
- 保持 Origin、CSRF、幂等键、revision、稳定错误码和全局请求大小边界。
- 委员会暂停时拒绝提交会改变文件状态的 upload；安全读取不应仅因暂停而失败。
- 不实施 S3、provider 切换、文件审核/UI、清理 worker 或 Chair Local Agent。

需要测试：
- STAGED 内容成功原子提交，最终路径由 blob ID 派生，重新读取的大小和 SHA-256 匹配。
- provider 写入、fsync、原子提交、重新校验或数据库事务任一步失败时，不产生 file version，暂存副本仍可重试。
- 同幂等键重试只产生一个 blob/version；不同请求复用 key 返回稳定冲突。
- 用户文件名和路径逃逸输入不能改变最终目标；符号链接、硬链接和非普通文件被拒绝。
- 暂停委员会拒绝最终提交；actor、事件、审计和 upload/file 状态保持原子。
- 未配置真实 PostgreSQL 时集成测试明确 skip；没有真实持久卷时把断电、重启和 fsync 证据写入 MANUAL_ACCEPTANCE.md。

完成后运行：
- 针对性 Vitest
- pnpm test:self-host
- pnpm build:self-host
- pnpm test:self-host:integration
- git diff --check

更新 PROJECT_ARCHITECTURE.md、相关 README、DATA_API_SPEC.md、IMPLEMENTATION_PLAN.md、MANUAL_ACCEPTANCE.md 和 RUNNING_LOG.md，只描述已落地事实。将 6.3 单独提交，然后继续阶段 6.4。
```
