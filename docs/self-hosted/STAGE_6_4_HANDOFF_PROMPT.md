# 阶段 6.4 交接 Prompt

```text
继续 Quorum 自托管迁移，只实施阶段 6.4：S3_COMPATIBLE provider。

仓库：/home/makoto/code/Quorum
分支：self-host
基线：阶段 6.3 提交后的 HEAD。开始前用 git log、git status 和 docs/self-hosted/RUNNING_LOG.md 核对，不假定工作区干净。

开始前：
1. 阅读 AGENTS.md、PROJECT_ARCHITECTURE.md，以及 docs/self-hosted/ 下的 ARCHITECTURE.md、DATA_API_SPEC.md、STORAGE_AGENT_SPEC.md、IMPLEMENTATION_PLAN.md、MANUAL_ACCEPTANCE.md 和 RUNNING_LOG.md。
2. 所有项目命令前执行 source scripts/wsl-env.sh。
3. 复跑阶段 6.3 针对性测试和 pnpm build:self-host。

只实施 6.4：
- 增加实例级 S3 compatible provider 配置与活动 binding 所需 migration。配置保存 endpoint、region、bucket、prefix、寻址方式和加密凭据；密钥不得明文落库或出现在日志、事件、审计和响应中。
- 使用显式实例 master key 做带版本的认证加密；缺失、错误或无法解密时 readiness/命令返回稳定错误，不得静默回退到明文或默认凭据链。
- 只有系统管理员可创建、更新、停用或验证 provider 配置；Chair 只能把委员会绑定到获准且活动的配置，不能读取凭据或任意 endpoint。
- endpoint 必须经过严格 URL 与网络目标校验；默认 HTTPS，拒绝 URL 凭据、fragment、非预期 scheme，以及会造成 SSRF 的回环、链路本地、私网和元数据地址。若设计允许内网对象存储，必须由系统管理员显式 allowlist，不能由 Chair 绕过。
- S3 object key 只由配置 prefix 与服务器 blob UUID 派生；用户文件名、logical name 和 media type 不得参与 key。
- 只处理完整 STAGED upload。由服务器从 durable staging 流式上传，执行请求/单文件上限；上传完成后用可信响应和重新读取/校验确认实际大小与 SHA-256，再复用阶段 6.3 的原子数据库提交边界。
- S3 或数据库失败时保留有效 STAGED 暂存副本。数据库失败后的重试必须复用原 blob/object key，不产生第二个 blob/version；已完整写入但尚未引用的对象留给后续清理，不在本阶段扩大删除范围。
- 为 provider 抽象补充安全读取、完整性验证和删除原语，但不开放未经授权的下载或物理删除工作流。
- 保持 Session、Origin、CSRF、幂等键、稳定错误码、暂停委员会和权限边界；不改变 Firebase 默认运行时。
- 不实施 provider 切换/复制、文件审核 UI、公开下载、清理 worker、Chair Local Agent、归档或 Firebase 移除。

需要测试：
- S3 配置凭据加密往返、错误 master key、密文篡改和响应/审计脱敏。
- 非管理员不能管理配置；Chair 只能选择获准配置；停用或未获准配置不能用于新提交。
- endpoint SSRF、危险 scheme、URL 凭据和 object key 路径输入被拒绝；用户名称不能改变 object key。
- STAGED 内容流式上传并在远端重新校验；超限、短写、网络中断、远端错误、哈希不匹配和读取失败均不创建 file version。
- 数据库故障及同幂等键重试只产生一个 blob/version，并保留可重试暂存；暂停委员会拒绝提交。
- 未配置真实 PostgreSQL 或 S3 测试服务时相应集成测试明确 skip；真实桶的 multipart 中断、权限、TLS、重启和兼容性证据写入 MANUAL_ACCEPTANCE.md。

完成后运行：
- 针对性 Vitest
- pnpm test:self-host
- pnpm build:self-host
- pnpm test:self-host:integration
- git diff --check

更新 PROJECT_ARCHITECTURE.md、相关 README、DATA_API_SPEC.md、STORAGE_AGENT_SPEC.md、IMPLEMENTATION_PLAN.md、MANUAL_ACCEPTANCE.md 和 RUNNING_LOG.md，只描述已落地事实。将 6.4 单独提交，然后继续阶段 6.5。
```
