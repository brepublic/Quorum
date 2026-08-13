# 阶段 6.5 交接 Prompt

```text
继续 Quorum 自托管迁移，只实施阶段 6.5：文件审核、发布、下载和永久删除。

仓库：/home/makoto/code/Quorum
分支：self-host
基线：阶段 6.4 提交后的 HEAD。开始前用 git log、git status 和 docs/self-hosted/RUNNING_LOG.md 核对，不假定工作区干净。

开始前阅读仓库与 self-hosted 文档；所有项目命令前执行 source scripts/wsl-env.sh；复跑阶段 6.4 针对性测试和 pnpm build:self-host。

只实施 6.5：
- 定义 UPLOAD_COMPLETE/PENDING_REVIEW/PUBLISHED 的显式审核状态机、权限、revision、事件和审计；普通 member 只能管理自己的文件，Chair/Owner 按规格审核与发布。
- 提供授权的文件列表、详情和下载。PUBLIC/PRIVATE audience 与委员会 membership/Chair/Owner 边界必须和快照一致；删除或未发布文件不得泄露存在性。
- 下载只从 file_version 绑定的活动 provider 读取并在响应前验证大小/SHA-256。安全编码 Content-Disposition filename 和 filename*；HTML、SVG、XML、脚本及无法确认的类型强制 attachment，设置 nosniff、私有缓存和 CSP/隔离头，禁止同源内联执行。
- 支持版本化文件追加时复用 durable upload/provider 原子边界，并执行 baseRevision；不得修改既有 file_version。
- 逻辑删除立即清除 current version、追加墓碑并使列表/下载不可见；物理删除使用显式 durable job，只有 provider 确认或安全幂等 not-found 后才把 blob 标记 DELETED。失败保持 DELETE_PENDING 并可重试。
- SERVER_VOLUME 与 S3 使用统一 provider 读取/删除接口；不得从用户输入选择路径、endpoint 或 object key。
- 保持 Session、Origin、CSRF、幂等、暂停委员会和 stable error 边界。安全读取可以在暂停状态下继续，文件状态写入必须拒绝暂停。
- 不实施 provider 切换、磁盘清理策略/UI、Chair Local Agent、归档或 Firebase 移除。

需要测试：状态机授权与并发 revision；危险文件名/媒体类型下载头；PUBLIC/PRIVATE/删除/未发布防枚举；读取完整性失败；两个 provider 的读取；逻辑删除事务原子性；物理删除成功、not-found、失败重试和墓碑防复活；未配置 PostgreSQL/S3 时明确 skip。

完成后运行针对性 Vitest、pnpm test:self-host、pnpm build:self-host、pnpm test:self-host:integration、git diff --check。更新架构、API、存储、实施、人工验收和 running log，只描述已落地事实。将 6.5 单独提交，然后继续阶段 6.6。
```
