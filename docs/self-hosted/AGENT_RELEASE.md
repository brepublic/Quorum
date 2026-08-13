# Chair Storage Agent 发布流程

阶段 7.6 提供可复现的 Windows x86-64、macOS x86-64、macOS arm64 发布包和非阻断 Linux x86-64 构建。包内包含 Agent 0.1.0、固定的 Node.js 22.23.2 运行时、安装说明和 Node.js 许可证；目标电脑不需要仓库、Node.js、pnpm 或开发依赖。

## 构建与验证

所有项目命令前先执行：

```sh
source scripts/wsl-env.sh
```

联网构建会从 `scripts/storage-agent-runtime-lock.json` 固定的 Node.js 官方 URL 下载运行时，并在提取前核对上游 SHA-256：

```sh
pnpm release:storage-agent
```

运行时缓存位于忽略的 `.tools/storage-agent-runtimes/`。已有完整缓存时可禁止网络访问：

```sh
pnpm release:storage-agent --offline
pnpm release:storage-agent:verify
```

输出位于忽略的 `release/storage-agent/`：

- `quorum-storage-agent-0.1.0-win-x64.zip`
- `quorum-storage-agent-0.1.0-darwin-x64.zip`
- `quorum-storage-agent-0.1.0-darwin-arm64.zip`
- `quorum-storage-agent-0.1.0-linux-x64.tar.gz`
- `release-manifest.json`
- `SHA256SUMS`

归档器固定路径顺序、时间戳、所有者和权限。验证器检查归档根目录、入口、Node/Agent 版本、运行时哈希、POSIX 执行位、开发文件、私有状态和本地绝对路径。设置 `QUORUM_AGENT_RELEASE_FORBIDDEN_VALUE` 可把 CI 中的 canary secret 加入精确泄漏扫描。

发布前应在两个独立目录重复构建，并比较归档 SHA-256。提交到发布渠道的是发布包、`release-manifest.json` 和 `SHA256SUMS`，不是 `staging/` 或运行时缓存。

## 安装、升级与卸载

每个归档内的 `INSTALL.md` 给出目标系统步骤。安装目录按版本隔离，私有配置和用户选择的存储目录位于版本目录之外。升级时停止旧进程、解压新版本并使用原 `--config` 启动；不得重新配对、重写共享目录元数据或清空 pending/conflict recovery 状态。确认新版本完成一次同步后再删除旧程序目录。

卸载默认只删除版本化程序目录。先在 Quorum 中转移或撤销主机；不得默认删除私有配置或用户选择的存储目录。是否删除这些数据必须由管理员根据委员会保留策略另行决定。

## Windows 签名接口

未签名包可在 WSL 生成。正式发布必须在安装 Windows SDK 且私钥已导入受保护证书存储的 Windows runner 上执行：

```powershell
$env:QUORUM_WINDOWS_SIGNING_CERT_SHA1 = '<certificate thumbprint>'
$env:QUORUM_SIGNTOOL_PATH = '<absolute path to signtool.exe>'
node scripts/sign-storage-agent-release.mjs --target win-x64
node scripts/build-storage-agent-release.mjs --archive-only --target win-x64
node scripts/verify-storage-agent-release.mjs
```

可用 `QUORUM_WINDOWS_TIMESTAMP_URL` 覆盖默认 RFC 3161 时间戳服务。脚本使用 SHA-256 签名与时间戳，并立即执行 `signtool verify /pa /v`。证书私钥和密码不通过环境变量、参数、仓库或产物传递；CI 只提供证书存储和非秘密 thumbprint。Microsoft 要求当前 SignTool 显式指定文件和时间戳摘要算法，详见 [SignTool 文档](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)。

## macOS 签名与公证接口

正式发布必须在具有 Developer ID Application 身份、Xcode 命令行工具和受保护 keychain 的 macOS runner 上执行。两个架构分别签名并重建归档：

```sh
export QUORUM_MACOS_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID)'
node scripts/sign-storage-agent-release.mjs --target darwin-arm64
node scripts/build-storage-agent-release.mjs --archive-only --target darwin-arm64
node scripts/sign-storage-agent-release.mjs --target darwin-x64
node scripts/build-storage-agent-release.mjs --archive-only --target darwin-x64
node scripts/verify-storage-agent-release.mjs
```

脚本启用 hardened runtime 和安全时间戳，并立即执行严格 `codesign` 校验。公证凭据应预先保存为 keychain profile；仓库和命令行只接收 profile 名称：

```sh
export QUORUM_MACOS_NOTARY_KEYCHAIN_PROFILE='quorum-storage-agent'
node scripts/notarize-storage-agent-release.mjs --artifact release/storage-agent/quorum-storage-agent-0.1.0-darwin-arm64.zip
node scripts/notarize-storage-agent-release.mjs --artifact release/storage-agent/quorum-storage-agent-0.1.0-darwin-x64.zip
node scripts/verify-storage-agent-release.mjs
```

公证成功后脚本只在外部 release manifest 标记 `notarized: true`；ZIP 字节和 SHA-256 不变，Gatekeeper 在线获取 ZIP 的票据。Apple 要求 Developer ID、hardened runtime、安全时间戳和 `notarytool`/Notary API，详见 [分发签名](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac)与[公证流程](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。

WSL 没有 Windows SDK、Windows 证书存储、macOS `codesign`、Xcode keychain 或 Gatekeeper，不能产出签名/公证通过证据。目标系统验证项目见 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-514。
