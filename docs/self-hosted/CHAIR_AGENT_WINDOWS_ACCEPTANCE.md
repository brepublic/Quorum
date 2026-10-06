# Windows Chair Agent 验收记录

## 2026-10-06：原生窗口适配

- 正式 Rust GUI 在 Windows MSVC 上构建通过；Rust 测试 6 项、桌面配置测试 5 项通过。
- Computer Use 操作正式窗口：打开 Windows 原生 CA 选择器，选择 `D:\Projects\root.crt` 后正确回填；切换简体中文、输入中文文本、Ctrl+A/C/V 与 Tab 切换焦点通过。初次截图暴露中文回退字形缺失，指定 Microsoft YaHei 后复查完整显示。
- 正常关闭未启动同步的窗口后，窗口退出。单实例转交及重新取得锁由 Rust 测试验证。
- 沙箱外使用 Node 和指定 CA 访问 `https://localhost/health/ready` 返回 200，未关闭 TLS 校验。
- 用户人工确认中文输入法正常使用，Windows 125% 缩放下未见显示异常。此项依据用户实际操作反馈；其他缩放比例未验收。
- 以下第二阶段补充 Windows 目录锁、长期凭据 ACL 和进程行为；完整服务器业务验收与发行尚未执行。

开发启动：`pnpm start:storage-agent:desktop:windows`。Windows 配置和语言偏好共用 `%LOCALAPPDATA%\quorum-agent`。

## 2026-10-06：安全与进程行为

- contracts、Node Agent 和两个正式 Windows Rust 可执行文件构建通过。Windows Agent 测试 12 个文件、130 项通过；Linux 专用锁测试 1 项按平台跳过。
- Windows Rust 原生测试 8 次执行全部通过（GUI 7 项、辅助程序 1 项；共享 Job Object 测试在两者中各执行一次）。沙箱内权限测试曾因访问限制失败，在真实 Windows 权限环境中重跑通过。
- 实际跨进程测试确认同一目录和大小写别名互斥，杀死持锁 Node 后可重新取得锁，junction 根目录被拒绝；ACL 开放给 Everyone 后凭据读取被拒绝。
- Windows 文件被占用时，配置原子替换失败保留原内容并删除临时文件；解除占用后可替换。大小写路径更新保留新文件内容。隔离 HTTPS 桥接测试覆盖同步启停、配置恢复及错误处理。
- Job Object 原生测试启动真实 Node 子进程和孙进程，关闭 Job 后二者退出。正式 GUI 正常关闭后桥接进程退出；强制结束测试 GUI（PID 423528）后，其桥接进程（PID 425100）也退出。该窗口检查发生于登录前，不能代替活动同步时的窗口验收。
- Linux 隔离副本的 contracts/Agent 构建通过，相关 Node 回归 76 项和 Unix 平台 Rust 回归 9 项通过。完整 Linux GUI 的离线依赖缓存缺少 rfd，因此未完成整窗构建；上述 Unix 测试不包含 Slint 窗口构建。
- 正式窗口地址为 `https://localhost`，原生选择器回填 `D:\Projects\root.crt`。用户手工登录并启动「东南亚国家联盟」委员会后，Computer Use 确认窗口处于运行中，存储目录为 `C:\Users\colin\Documents\Quorum\东南亚国家联盟-1`。
- 活动同步时点击停止，CLI 和持锁辅助程序退出；再次启动恢复运行。运行中正常关闭窗口，GUI（431496）、桥接（431560）及 CLI（445252）均退出；重开后自动恢复同一委员会并运行。
- 活动同步时强制结束 GUI（444956），桥接（446348）及 CLI（442200）均退出；再次重开自动恢复运行，无残留目录锁。GUI 运行期间，同配置 CLI 以退出码 1 和 `AGENT_ALREADY_RUNNING` 拒绝重复同步，未超时。
- 「打开目录」实际唤起 Windows 资源管理器并显示正确的同步目录。验收结束将 GUI 留在运行中。
- 用户已确认中文输入法正常、125% 缩放下未见异常，前两个阶段的 Windows 本机验收完成。当前委员会暂无文件，活动同步生命周期验收不等于上传／下载、冲突或断网恢复的第三阶段业务验收；完整 Linux GUI 构建仍保留上述未完成记录。

重跑 Windows 测试前先加载 `scripts/windows-env.ps1`，构建辅助程序，并将 `QUORUM_AGENT_NODE` 指向 Node 可执行文件。HTTPS 桥接测试需要 PATH 中可用的 OpenSSL；本机使用已有 Git for Windows 自带的 OpenSSL。测试不连接真实委员会、不放宽 TLS 校验。
