# 阶段 7.5 交接 Prompt：Agent 管理与冲突裁决 UI

继续 Quorum 自托管迁移，只实施阶段 7.5：Agent 管理、离线恢复和冲突裁决 UI。

开始前核对 `self-host` 分支与阶段 7.4 提交，阅读 `AGENTS.md`、`PROJECT_ARCHITECTURE.md` 和 `docs/self-hosted/` 全部相关规格。所有项目命令前执行 `source scripts/wsl-env.sh`，复跑 `packages/storage-agent` 定向测试与 `pnpm build:self-host`。

本阶段完成：

- 为 Owner/Chair 提供一次性配对码、当前 host、最后在线时间、撤销与转移操作；普通 member 和仅有 `SYSTEM_ADMIN` 的账号不得获得隐式权限。
- 在文件页显示 `ACTIVE`、`DEGRADED`、`OUT_OF_SYNC`、`PENDING_HOST_COMMIT` 和恢复进度；Agent 离线不得暂停议事。
- 增加只读冲突列表和显式裁决命令。裁决必须绑定 conflict revision、当前 lease generation、文件 revision、Origin、CSRF 和幂等键；任何陈旧状态返回稳定冲突并重新获取权威快照。
- 支持保留服务端版本、采用本地待上传版本或另存为新逻辑文件；墓碑不得被“采用本地版本”静默复活，永久删除需要独立明确动作。
- Agent 本地程序只输出无秘密、无绝对路径的稳定状态；不得把设备凭据、私钥、配对码、claim token、文件正文或本地路径送到浏览器、事件、审计或日志。
- 精简简体中文界面文案，补齐键盘、焦点、窄屏和错误恢复测试。

不得在本阶段实施 Windows/macOS 安装器或签名、归档/导出、备份策略、委员会永久删除或 Firebase 移除。

完成后运行 Agent/UI/HTTP/PostgreSQL 针对性 Vitest、`pnpm test:self-host`、`pnpm build:self-host`、`pnpm build`、`pnpm test:self-host:integration` 和 `git diff --check`。真实 PostgreSQL、TLS、多设备、浏览器视觉与辅助功能无法执行时必须明确 skip，并写入 `MANUAL_ACCEPTANCE.md`。更新 `PROJECT_ARCHITECTURE.md`、相关 README、`IMPLEMENTATION_PLAN.md`、`MANUAL_ACCEPTANCE.md` 和 `RUNNING_LOG.md`，只描述已落地事实；阶段 7.5 单独提交后继续 7.6 发布包。
