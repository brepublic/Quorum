# 开发环境主席 Agent 安装包

安装包按需手动生成。修改源码、启动网页或刷新页面不会自动打包。
下载菜单使用最近一次成功准备的包；它不表示当前工作区代码已经重新编译。

## Linux

在仓库根目录执行：

```sh
source scripts/wsl-env.sh
pnpm dev:chair-agent:build:linux
pnpm dev:chair-agent:prepare --platform linux --from release/appimage
```

构建命令先检查 `packages/` 和 `scripts/` 中未跟踪的新文件，再调用现有
`release:storage-agent:appimage` 命令，完成 AppImage 构建及原有 smoke 检查。
若提示新文件未跟踪，请检查列表，对确实属于源码的文件执行 `git add <文件>`，
对无关临时文件移出源码目录，再重新构建。允许已跟踪文件有未提交修改。
构建期间不要修改源码。构建需要现有 Docker、固定工具链及其下载条件。

## Windows

在原生 Windows PowerShell 的仓库根目录执行：

```powershell
. .\scripts\windows-env.ps1
pnpm dev:chair-agent:build:windows
```

命令通过相同的新文件检查后，调用现有 Windows EXE 打包流程。
Windows 工具链准备见 `CHAIR_AGENT_WINDOWS_SETUP.md`。

将生成的整个 `release/windows/` 目录复制到运行 Vite 的开发机，例如
`release/windows-local/`。必须包含 `release-manifest.json`、EXE、ZIP 和对应源码包，
因为准备命令会校验清单列出的全部文件。然后在开发机仓库根目录执行：

```sh
source scripts/wsl-env.sh
pnpm dev:chair-agent:prepare --platform windows --from release/windows-local
```

如果 Windows 构建输出本来就在该开发机可读取的 `release/windows/`，则使用
`--from release/windows`。复用现有开发服务器，不在 Windows 新建服务或部署。

## 生效与再次更新

准备命令不会编译；已有合格产物可以直接准备。它会输出各平台的下载地址、
Agent 版本、提交编号以及是否包含未提交修改。允许只准备一个平台，更新该平台
会保留另一平台的已有包；两个平台不保证来自同一提交或同一版本。

准备成功后，停止原有 Vite 进程，再在仓库根目录执行：

```sh
source scripts/wsl-env.sh
pnpm start
```

刷新浏览器，在“资料 → 存储设置 → 下载主席端”中选择平台。开发包标记为
“本地开发构建”，没有 GitHub 发行链接。再次更新时重复构建、准备、重启步骤。

每个平台的地址使用安装包 SHA-256；包内容变化时地址随之变化。准备失败不改变
当前清单，旧安装包副本保留，仍在运行的 Vite 可继续提供启动时载入的包。
准备命令请顺序执行；若进程被强制结束，确认没有准备进程运行后，可删除
`release/dev-chair-agent/.prepare-lock` 再重试。

## 与正式发布隔离

开发文件仅存于被 Git 和 Docker 忽略的 `release/dev-chair-agent/`。
Vite 开发服务器将清单列出的地址 `/downloads/chair-agent/dev/<SHA-256>/<文件名>`
映射到该目录中的安装包，提供 GET/HEAD 附件响应；未列出的地址返回 404。
下载入口不开放目录浏览，不提供源码包或其他构建文件。

生产构建、Vite preview 和设置了 `RELEASE_TAG` 的构建均不读取开发清单。
正式发布仍使用 `public/downloads/chair-agent/manifest.json`、原准备脚本和 Caddy；
双平台、同提交、干净源码及全部文件校验要求保持不变。开发包不会复制进网站镜像。

实际原生安装、启动和连接验收需要在对应操作系统执行；下载哈希校验不替代它们。
