# 阶段 7.4 交接 Prompt

继续 Quorum 自托管迁移，只实施阶段 7.4：桌面 Agent 文件系统核心与恢复循环。

仓库：`/home/makoto/code/Quorum`
分支：`self-host`
基线：阶段 7.3 的单独提交，以 `git log -1` 为准。

开始前：

1. 用 `git log` 和 `git status` 核对基线，不假定工作区干净。
2. 阅读 `AGENTS.md`、`PROJECT_ARCHITECTURE.md`、`docs/self-hosted/RUNNING_LOG.md`，以及本目录的架构、数据/API、存储 Agent、实施计划和人工验收文档。
3. 所有项目命令前执行 `source scripts/wsl-env.sh`。
4. 复跑阶段 7.3 的 migration、Chair provider、local-change、HTTP、任务和文件页针对性测试及 `pnpm build:self-host`。

只实施 7.4：

- 建立独立、可测试的 Agent 运行时核心；凭据和用户选择的绝对根目录只保存在 Agent 本机，不进入浏览器、manifest、事件、审计或普通日志。
- 初始化根目录时写入不含秘密的 `.quorum-storage.json`，校验委员会/设备绑定；拒绝根目录本身、元数据文件或内部临时目录为普通用户内容。
- 启动与重连必须先拉取完整最新 manifest，先应用墓碑，再处理 UPSERT，最后扫描并上报本地变化；游标缺口或未知状态回退完整恢复，不凭本地缓存猜测服务器状态。
- 服务器下发内容只能写入根目录内服务器生成的临时文件；逐块校验大小和 SHA-256，执行文件同步后无覆盖原子重命名。失败、断流、崩溃或哈希错误不得让部分文件冒充完整文件。
- 所有相对路径必须规范化，拒绝绝对路径、`..`、符号链接/重解析点逃逸、设备文件、socket/FIFO、硬链接别名和保留元数据/临时路径。用户文件名不得决定秘密或根目录外路径。
- 文件监测只作为低延迟提示；周期完整扫描是最终依据。扫描比较相对路径、普通文件类型、大小、mtime 和必要时 SHA-256，并以 7.3 `local-changes` 的 request ID、manifest sequence 与 file revision 上报新增、修改、重命名和删除。
- 本地 apply 与扫描必须抑制自身写入回声；墓碑、较新服务器 revision 和 `CHAIR_DECISION_REQUIRED` 冲突保留本地内容，不静默覆盖或删除冲突副本。
- task 循环必须支持 claim、内容上传/下载、complete/fail、五分钟 stale claim 恢复、指数退避、heartbeat、取消和优雅停机；每次提交继续携带当前 lease generation。
- 本节实现跨平台 Node 文件系统核心和 CLI/测试入口即可；不实施 GUI、安装器、自动更新、代码签名/notarization、Windows/macOS 发布包、归档、备份或 Firebase 移除。

需要测试：

- 墓碑优先恢复阻止旧本地文件复活；完整 manifest 可从空目录收敛，并对重复运行幂等。
- 下发文件使用同根临时文件、完整校验和原子替换；短写、长写、断流、哈希错误、磁盘失败和进程终止不留下可见完整文件。
- 路径逃逸、符号链接、硬链接、设备文件和保留路径全部拒绝；日志/状态不含凭据、绝对根目录或正文。
- watcher 丢事件时周期扫描仍发现新增、修改、重命名和删除；自身 apply 不回传为本地用户变化。
- 离线重试、claim 超时、host transfer 和 stale generation 不产生重复版本或旧主机写入；冲突保留本地内容并要求 Chair 决策。
- Windows 与 macOS 路径语义以平台适配单元测试覆盖；当前 WSL 不能替代 NTFS、APFS、安装或签名实测，必须写入人工验收。

完成后运行：

- 针对性 Vitest
- `pnpm test:self-host`
- `pnpm build:self-host`
- `pnpm build`
- `pnpm test:self-host:integration`
- `git diff --check`

更新 `PROJECT_ARCHITECTURE.md`、相关 README、`DATA_API_SPEC.md`、`STORAGE_AGENT_SPEC.md`、`IMPLEMENTATION_PLAN.md`、`MANUAL_ACCEPTANCE.md` 和 `RUNNING_LOG.md`，只描述已经落地的事实。把 7.4 单独提交，并为下一阶段撰写新的交接 Prompt；提交后继续实施后续阶段。
