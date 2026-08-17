# 阶段 6 交接 Prompt

```text
继续 Quorum 自托管迁移，实施 docs/self-hosted/IMPLEMENTATION_PLAN.md 的阶段 6：服务器卷和 S3 文件。

仓库：/home/makoto/code/Quorum
分支：self-host
基线：阶段 5 最终文档提交后的 HEAD。开始前用 git log 和 git status 核对，不假定工作区干净。

开始前：
1. 阅读 AGENTS.md、PROJECT_ARCHITECTURE.md，以及 docs/self-hosted/ 下的 ARCHITECTURE.md、DATA_API_SPEC.md、RULE_PACKAGE_SPEC.md、STORAGE_AGENT_SPEC.md、CURRENT_BEHAVIOR_BASELINE.md、IMPLEMENTATION_PLAN.md 和 MANUAL_ACCEPTANCE.md。
2. 所有项目命令前执行 source scripts/wsl-env.sh。
3. 保留无关改动；默认/Firebase 运行时必须保持现有行为；self-hosted 模式只使用同源 API，不允许双写。
4. 先复跑阶段 5 的关键测试，确认 SSE、计时器、发言、动议、ballot、意向性投票和版本化决议草案没有回归。

按可独立验收的小阶段实施，每个小阶段完成针对性测试、pnpm build:self-host、git diff --check 并分别提交：

6.1 文件元数据、版本、存储绑定和墓碑
- PostgreSQL 是逻辑文件、版本、哈希、大小、状态、绑定和删除墓碑的唯一业务真相。
- 文件版本和墓碑追加保存；删除后立即不可见，不能由旧副本复活。
- actor 由 Session 推导；状态、委员会事件和审计同事务提交。

6.2 durable staging 与流式上传
- 创建 upload 后流式写入持久暂存区；执行字节上限、实际大小和 SHA-256 校验。
- 不把用户文件名拼接为磁盘路径；内部 staging/blob key 必须防路径逃逸。
- 暂存是唯一有效副本时不得由 LRU 或普通过期清理删除。
- 未完整提交的上传不能产生可下载 file version。

6.3 SERVER_VOLUME provider
- 使用内部 blob ID 派生持久卷路径；原子提交并重新校验大小和 SHA-256。
- provider 成功后再在数据库事务中发布版本；失败保留可重试状态，不产生空内容记录。
- 下载使用安全 Content-Disposition；用户 HTML、SVG 等危险类型不得同源内联执行。

6.4 S3_COMPATIBLE provider
- 系统管理员管理实例级 endpoint、region、bucket、prefix 和加密凭据；Chair 只能选择获准配置，不能读取凭据。
- 上传、读取、删除和校验通过 provider 接口；腾讯云 COS 按 S3 兼容接口接入。
- 密钥不得进入浏览器、事件、审计摘要或普通日志。

6.5 审核、发布、下载和永久删除
- 明确上传完成、待审核、已发布和已删除状态；公开/member/Chair/Owner 下载授权分级。
- 永久删除创建不含可恢复内容的墓碑，并安排 provider 物理删除。
- 文件名、MIME、大小和哈希来自服务端验证；不要信任浏览器声明。

6.6 provider 切换与失败回退
- 复制期间旧 provider 继续服务；全部 blob 校验成功后才原子切换 binding。
- 失败保持旧 binding 生效并记录可重试状态；不得形成部分切换。
- revision、幂等键和稳定错误码边界保持不变。

6.7 磁盘阈值和后台清理
- 80% 产生告警，90% 拒绝新内容上传；已有下载和议事不受影响。
- 只清理已提交、明确取消或失败且过期的暂存；清理任务幂等并有审计/指标。
- readiness 反映必要存储不可用，但普通 provider 故障不能篡改 PostgreSQL 业务状态。

6.8 自托管文件 UI 与阶段收尾
- 使用简体中文模拟联合国术语和必要、简短文案；提供上传、状态、审核、发布、下载、删除和 provider 设置入口。
- 不实施阶段 7 的 Chair Local Agent、设备配对、lease generation、fencing 或本地目录同步。
- 更新 PROJECT_ARCHITECTURE.md、相关 README、实施状态和 MANUAL_ACCEPTANCE.md。

全程保持：
- Session、Origin、CSRF、revision、幂等键、请求大小和稳定错误码边界。
- PUBLIC/member/Chair/Owner 授权分级；SYSTEM_ADMIN 不自动获得委员会 Chair 权限。
- 委员会暂停时拒绝会改变议事/文件发布状态的命令，但不要无理由阻断安全下载。
- SSE 只是通知传输；文件二进制 provider 不是权限或业务状态真相。
- 不提前实施阶段 7–9。

阶段 6 完成后至少运行：
- pnpm exec vitest run
- pnpm test:self-host
- pnpm build
- pnpm build:self-host
- pnpm test:self-host:integration
- git diff --check

如具备条件，再运行真实 PostgreSQL、Docker Compose、Caddy/TLS、S3 兼容测试桶、磁盘阈值和 Firebase emulator/Cypress 回归。缺少环境时不得伪造通过；把步骤、通过条件和证据要求追加到 docs/self-hosted/MANUAL_ACCEPTANCE.md。
```
