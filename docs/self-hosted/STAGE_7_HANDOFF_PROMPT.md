# 阶段 7 交接 Prompt

```text
继续 Quorum 自托管迁移，实施阶段 7：Chair Local Agent。阶段较大，先把 7.1（协议、配对、设备身份与单主机 fencing）作为独立提交，再继续任务/manifest、桌面 Agent、本地目录同步和发布包。

仓库：/home/makoto/code/Quorum
分支：self-host
基线：阶段 6.8 提交后的 HEAD。开始前用 git log、git status 和 docs/self-hosted/RUNNING_LOG.md 核对，不假定工作区干净。

开始前：
1. 阅读 AGENTS.md、PROJECT_ARCHITECTURE.md，以及 docs/self-hosted/ 下的 ARCHITECTURE.md、DATA_API_SPEC.md、STORAGE_AGENT_SPEC.md、IMPLEMENTATION_PLAN.md 和 MANUAL_ACCEPTANCE.md。
2. 所有项目命令前执行 source scripts/wsl-env.sh。
3. 复跑阶段 6.8 针对性测试和 pnpm build:self-host。
4. 先把 STORAGE_AGENT_SPEC.md 的设备身份、凭据格式、配对码期限、lease generation、任务状态、manifest 游标和路径边界收敛为可测试契约；只在实现同步推进时写当前架构文档。

阶段 7.1：
- 新 migration 增加一次性配对码哈希、设备公钥/凭据哈希、storage host、lease generation、撤销和最后在线状态。明文配对码与设备凭据只显示一次，不写数据库、日志、事件或审计。
- Chair/Owner 可创建短期一次性配对码、查看主机状态、撤销或转移；SYSTEM_ADMIN 不自动获得 Chair 权限。
- Agent 配对后取得只限单委员会 storage-agent API 的可撤销凭据。浏览器 Session 与 Agent 凭据使用不同认证边界；Agent 不能调用账号或议事管理接口。
- 每个 Agent 写请求携带 lease generation；转移、撤销或重新配对原子递增 generation。旧设备、迟到请求和旧任务完成稳定返回 STALE_STORAGE_LEASE，不能改变文件、host、task 或 manifest 状态。
- 同一委员会只能有一个活动 host；并发配对/转移由 PostgreSQL 行锁和唯一约束收敛。
- 心跳只更新固定状态与最后在线时间，不自动暂停委员会；超时只产生 STORAGE_DEGRADED 状态/事件。

阶段 7 后续：
- durable Agent task、manifest sequence、claim token、幂等完成/失败、服务器暂存与 blob 校验；
- 本地 Agent 主动 HTTPS 拉取，无入站端口；本地目录 marker 不含秘密；路径拒绝绝对路径、..、符号链接逃逸、设备文件和保留路径；
- 文件监测仅作提示，定期完整扫描为最终依据；下载先写临时文件、校验大小/SHA-256 后原子替换；
- 墓碑优先于离线副本，删除文件不能复活；冲突保留内容并要求 Chair 决定，不静默覆盖；
- 离线期间议事继续，服务器有效暂存可服务时按契约下载；恢复先拉墓碑和 manifest；
- Windows x86-64 与 macOS 发布包是阶段阻断项，Linux 构建预留。当前 WSL 无法完成签名、公证和真实桌面文件监测时，必须写入 MANUAL_ACCEPTANCE.md，不得标记通过。

不得在阶段 7 实施归档、账号匿名化、备份或 Firebase 移除。每个 7.x 小阶段完成后运行针对性 Vitest、pnpm test:self-host、pnpm build、pnpm build:self-host、PostgreSQL integration（未配置时明确 skip）和 git diff --check，更新 running log 并单独提交，然后继续下一小阶段。
```
