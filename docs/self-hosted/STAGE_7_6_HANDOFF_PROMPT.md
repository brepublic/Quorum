# 阶段 7.6 交接 Prompt：桌面 Agent 发布包

继续 Quorum 自托管迁移，只实施阶段 7.6：Chair Local Agent 桌面发布包。

开始前核对 `self-host` 分支与阶段 7.5 提交，阅读 `AGENTS.md`、`PROJECT_ARCHITECTURE.md` 和 `docs/self-hosted/` 的架构、Agent、实施与人工验收规格。所有项目命令前执行 `source scripts/wsl-env.sh`，复跑阶段 7.5 的 Agent/UI/HTTP 定向测试与 `pnpm build:self-host`。

本阶段完成：

- 为 Windows x86-64 与 macOS 生成可复现的 Agent 发布产物；Linux 使用同一协议并保留非阻断构建入口。
- 发布包包含运行所需代码和明确版本，不依赖仓库源码、开发依赖或全局 pnpm；启动入口继续使用既有 `pair`、`start` 和 `status` 命令。
- 提供安装、升级、卸载和数据保留说明。升级必须保留私有配置、设备身份、共享目录元数据、pending upload 和 conflict recovery 状态；卸载不得默认删除用户选择的存储目录。
- 提供 Windows 代码签名与 macOS signing/notarization 的环境变量或 CI secret 接口、未签名本地构建路径、产物 SHA-256 和发布 manifest。不得提交证书、私钥、公证密码、临时凭据或实际签名材料。
- 固定平台、架构、Node/runtime 与依赖版本；校验 archive 内容、权限、入口、重复构建和秘密扫描。产物、日志、命令行与发布 manifest 不得包含 Agent 凭据、私钥、配对码、claim token、本地绝对路径或文件正文。
- 把 NTFS/APFS、Windows ACL、macOS 权限、安装/升级/卸载、SmartScreen/Gatekeeper、签名、公证、系统重启和原生 watcher 验证写入 `MANUAL_ACCEPTANCE.md`；WSL 不能替代这些证据。

不得在本阶段实施自动更新服务、归档/导出、备份策略、委员会永久删除或 Firebase 移除。若签名、公证或平台原生安装器因当前 WSL 缺少凭据/工具无法执行，保留可审计配置入口并明确标为待实机验证，不得伪造成功。

完成后运行发布脚本单元/静态测试、Agent 定向 Vitest、`pnpm test:self-host`、`pnpm build:self-host`、`pnpm build`、`pnpm test:self-host:integration` 和 `git diff --check`。更新 `PROJECT_ARCHITECTURE.md`、相关 README、`IMPLEMENTATION_PLAN.md`、`MANUAL_ACCEPTANCE.md` 和 `RUNNING_LOG.md`，只描述已生成及已验证的事实；阶段 7.6 单独提交后继续阶段 8。
