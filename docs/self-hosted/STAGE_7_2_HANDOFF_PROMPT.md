# 阶段 7.2 交接 Prompt

```text
继续 Quorum 自托管迁移，只实施阶段 7.2：durable Agent task、manifest 与服务器内容边界。

仓库：/home/makoto/code/Quorum
分支：self-host
基线：阶段 7.1 提交后的 HEAD。开始前用 git log、git status 和 docs/self-hosted/RUNNING_LOG.md 核对，不假定工作区干净。

开始前：
1. 阅读 AGENTS.md、PROJECT_ARCHITECTURE.md，以及 docs/self-hosted/ 下的 ARCHITECTURE.md、DATA_API_SPEC.md、STORAGE_AGENT_SPEC.md、IMPLEMENTATION_PLAN.md 和 MANUAL_ACCEPTANCE.md。
2. 所有项目命令前执行 source scripts/wsl-env.sh。
3. 复跑阶段 7.1 针对性测试和 pnpm build:self-host。

只实施 7.2：
- 新 migration 增加 CHAIR_AGENT binding 所需状态、durable Agent task、严格递增 manifest sequence、claim token、attempt、next attempt、stale claim、失败 code 和服务器内容 staging 关联。
- manifest 同时包含当前文件版本和墓碑；墓碑 sequence 优先，已删除文件不能由离线副本复活。
- Agent 使用阶段 7.1 的 QuorumAgent 凭据；每次 list/claim/complete/fail/content 请求都重新检查设备 credential、host 状态和 lease generation。
- task 至少冻结 task ID、类型、lease generation、file revision、预期大小和 SHA-256。重复 claim、complete 和 fail 必须幂等；旧 claim token、旧 generation 和主机转移后的迟到完成返回 STALE_STORAGE_LEASE，不能修改 task、manifest、文件或 host。
- task 与 manifest 业务状态、委员会事件和必要审计在 PostgreSQL 事务内一致。provider/数据库故障保留唯一有效暂存副本并可重试。
- Agent 内容上传和下载必须流式处理并重新校验实际大小与 SHA-256；不得先读入完整内存，不信任文件名、Content-Length 或客户端哈希。
- Agent 不能取得浏览器 Session 权限，浏览器不能读取设备凭据、本地路径或 Agent 内容暂存内部键。
- 本节不实现桌面可执行程序、目录选择、文件监测、完整扫描、原子本地替换、系统托盘或发布包。

需要测试：
- manifest sequence 严格递增，断线 after cursor 可补齐；墓碑覆盖旧版本且不能复活。
- 两个 worker 并发只有一个 claim；stale claim 可恢复，旧 token 不能完成。
- 转移/撤销与 task 完成并发时，只有当前 lease 可修改状态。
- 重复完成/失败幂等；不同结果冲突稳定失败。
- 短写、长写、超限、断流、哈希错误、provider 和数据库故障不发布部分内容。
- 任务、manifest、事件和审计在故障下注销或提交一致。
- 未配置真实 PostgreSQL 时集成测试明确 skip。

完成后运行针对性 Vitest、pnpm test:self-host、pnpm build、pnpm build:self-host、pnpm test:self-host:integration 和 git diff --check；更新架构、API、Agent、实施、人工验收与 running log，单独提交 7.2，然后继续 7.3 桌面 Agent 与本地目录同步。
```
