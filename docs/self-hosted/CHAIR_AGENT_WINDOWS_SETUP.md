# Chair Agent Windows 开发环境准备

目标为 Windows 11 x64 原生开发。GUI 的 Windows 平台适配仍待实施；以下步骤准备工具和依赖，不代表桌面功能已迁移。

## 工具与安装位置

| 工具 | 版本或要求 | 本 checkout 安装位置 | 安装方法 |
| --- | --- | --- | --- |
| Node.js | 22.23.2，与 runtime lock 一致 | `.tools/node-windows/node-v22.23.2-win-x64` | nodejs.org 官方 ZIP，校验官方 SHA-256 与仓库锁 |
| pnpm | 10.33.4，与 packageManager 一致 | `.tools/windows/pnpm` | 官方 Node 中的 npm，通过 registry.npmjs.org 安装固定版本 |
| Rust/Cargo | 1.98.1，`x86_64-pc-windows-msvc` | `.tools/windows/cargo`、`.tools/windows/rustup` | 官方 rustup，使用受支持的自定义 home，不修改系统 PATH |
| MSVC 与 Windows SDK | 微软 Build Tools 的 C++ 桌面工作负载 | 微软安装器管理的系统目录 | 用户运行微软签名安装器并处理管理员确认 |
| Slint | 1.17.1 | Cargo cache | Cargo.lock 管理，无需单独安装 GUI SDK |
| JavaScript 依赖 | pnpm-lock.yaml | workspace node_modules；store 在 `.tools/windows/pnpm-store` | `pnpm install --frozen-lockfile` |

Git 与 PowerShell 已有可用安装。Git 自带的 OpenSSL 可用于现有 HTTPS 测试。

## 开发服务器约定（用户确认，2026-10-06）

- 复用 WSL 中现有的 Quorum 开发服务器；不在 Windows 环境重新搭建 Docker 或开发服务器。
- 用户提供的连接入口为 `localhost:80`（需要 CA 证书）或 `http://localhost:5173`。
- 上述端口 80 的协议及重定向、CA 文件位置、Windows 到 WSL 的连通性和 Agent API 入口在连接验收时核对。本记录保留用户提供的地址，不假定已完成连通验证。
- 5173 是现有 Vite 开发入口；当前 Agent 正常账号／配对流程要求 HTTPS origin。后续按实际 API 和 TLS 配置选择连接入口，保留证书校验。

`.tools` 与构建产物均被 Git 忽略。工具只作用于载入环境脚本的 PowerShell 会话；新克隆需要重新安装。

## 每次进入项目

在 PowerShell 中运行：

```powershell
Set-Location D:\Projects\Quorum
. .\scripts\windows-env.ps1
node --version
pnpm --version
rustc --version
cargo --version
```

Windows 原生项目命令使用上述环境脚本。Linux/WSL 继续使用 `source scripts/wsl-env.sh`。

脚本保持 Rust 与 Node/pnpm 的路径独立于 Linux `.tools`，并将 npm cache 放在本 checkout。它不设置永久 PATH，不改变系统执行策略。若公司策略禁止 PowerShell 脚本，应按该策略处理，不能绕过。

## 安装微软编译工具

官方入口：https://visualstudio.microsoft.com/visual-cpp-build-tools/

本次已下载官方页面链接的 bootstrapper 到 `.tools/downloads/vs_BuildTools.exe`，并确认 Authenticode 为 `Valid`、签名发布者为 Microsoft Corporation。运行前可再次检查：

```powershell
Get-AuthenticodeSignature .\.tools\downloads\vs_BuildTools.exe |
    Select-Object Status, @{Name='Publisher';Expression={$_.SignerCertificate.Subject}}
```

1. 在自己的 PowerShell 中运行 `& .\.tools\downloads\vs_BuildTools.exe`，或在资源管理器双击。
2. 在 Windows 管理员确认中核对发布者为 Microsoft Corporation，再继续。
3. 在安装器选择“使用 C++ 的桌面开发”（Desktop development with C++）。
4. 确认安装详情包括 MSVC C++ x64/x86 编译工具以及一个 Windows SDK。使用安装器推荐的版本。
5. 在语言包中保留 English，可同时选择简体中文。
6. 等待安装完成；若安装器要求重启，完成重启。打开新的 PowerShell 并重新载入项目环境。

VS Code 不提供 MSVC linker。仅下载 bootstrapper 也不等于编译工具已安装。Build Tools 支持命令行部署，但此处保留系统安装器的组件选择和管理员交互。

完成后运行：

```powershell
.\scripts\check-windows-toolchain.ps1
```

该检查显示四个工具版本，再真实编译、运行一个最小 Windows Rust 程序。成功应输出 `Windows Rust toolchain OK`。`link.exe not found` 表示 MSVC 尚不可用；缺少 Windows 系统库则检查 SDK。该检查不编译正式 GUI。

## 安装依赖与构建

```powershell
. .\scripts\windows-env.ps1
pnpm install --frozen-lockfile --store-dir .tools/windows/pnpm-store --registry=https://registry.npmjs.org
pnpm --filter @quorum/contracts build
pnpm --filter @quorum/storage-agent build
cargo fetch --locked --target x86_64-pc-windows-msvc --manifest-path packages/storage-agent-desktop/Cargo.toml
```

安装保留现有 pnpm-lock.yaml、Cargo.lock 和 Slint 版本。pnpm 只运行 workspace 中批准的依赖构建脚本。

当前 `pnpm start:storage-agent:desktop` 仍调用 Linux Bash 脚本；正式 Rust GUI 中仍有 Unix API 和 Wayland/X11 扩展。MSVC 完成后下一阶段是适配这些代码及 Windows 原生启动入口。

## 重新准备工具

Node 官方版本页：https://nodejs.org/en/download/archive/v22.23.2

从该版本的官方目录下载 `node-v22.23.2-win-x64.zip` 与 `SHASUMS256.txt`。ZIP SHA-256 必须等于官方 manifest 和 `scripts/storage-agent-runtime-lock.json` 中 `win-x64.sha256`；使用 `Get-FileHash -Algorithm SHA256` 检查。将 ZIP 解压到 `.tools/node-windows`。

用该 Node 安装固定 pnpm：

```powershell
$quorumNodeDirectory = Join-Path $PWD '.tools/node-windows/node-v22.23.2-win-x64'
$env:PATH = "$quorumNodeDirectory;$env:PATH"
$env:npm_config_cache = Join-Path $PWD '.tools/windows/npm-cache'
& "$quorumNodeDirectory/npm.cmd" install --global --prefix "$PWD/.tools/windows/pnpm" pnpm@10.33.4 --registry=https://registry.npmjs.org --no-audit --no-fund
```

官方 Rust 安装说明：https://rust-lang.github.io/rustup/installation/index.html

下载 `https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe` 和同地址追加 `.sha256` 的官方校验文件，核对后保存于 `.tools/downloads`。配置自定义 home 后安装：

```powershell
$env:CARGO_HOME = Join-Path $PWD '.tools/windows/cargo'
$env:RUSTUP_HOME = Join-Path $PWD '.tools/windows/rustup'
& .\.tools\downloads\rustup-init.exe -y --no-modify-path --default-toolchain none --default-host x86_64-pc-windows-msvc --profile minimal
& "$env:CARGO_HOME/bin/rustup.exe" toolchain install 1.98.1-x86_64-pc-windows-msvc --profile minimal
& "$env:CARGO_HOME/bin/rustup.exe" default 1.98.1-x86_64-pc-windows-msvc
```

先下载 Rust 工具链可以完成缓存准备；编译 Windows 程序仍须安装 MSVC 和 Windows SDK。

## 本次环境验证（2026-10-06）

- Node 22.23.2、pnpm 10.33.4、rustc/Cargo 1.98.1 版本检查通过。
- pnpm 锁文件安装完成，contracts 与 Node Agent 构建通过。
- 现有配对配置与 Agent HTTP client 测试共 21 项通过；环境脚本重复载入验证通过。
- `cargo fetch --locked --target x86_64-pc-windows-msvc` 完成，Slint 1.17.1 及 Windows 依赖已缓存。
- 最小 Rust 原生编译明确报出 `link.exe not found`；MSVC/SDK 尚待用户安装。
- 现有发行测试在 Windows 上 3 项通过、1 项失败：跨目标组装测试依赖 POSIX 可执行权限，Windows staging 无法满足该检查。未改动该发行逻辑；此项列入后续 Windows 打包适配。
- Windows Codex 文件系统沙箱曾阻止 pnpm 对 checkout 执行 realpath；在批准的沙箱外执行中构建通过。此错误不能据此判断工具安装损坏，也不需要修改仓库权限。
