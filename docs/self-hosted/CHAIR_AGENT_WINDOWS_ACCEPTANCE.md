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

## 2026-10-06：阶段 3A 原生连接与身份流程

- 复用既有 WSL 开发服务器；指定既有 CA 的真实 HTTPS readiness 返回 200，数据库和存储检查正常，未关闭证书校验。
- 专用本地测试账号网页登录成功，创建 Windows Agent 验收 A、B 两个私有委员会。正式 Windows GUI 原生登录成功，候选列表正确显示该账号的两个委员会。
- 正式 GUI 从原连接切换到 A，运行中进入另一轮切换后取消，返回 A 的运行状态。随后停止并解除 A，GUI 显示已解除连接；服务器主机列表确认 A 为 REVOKED，无当前主机，本地测试目录保留。
- 通过原生账号流程首次配对 B；服务器确认一个 ACTIVE 主机、generation 1，并在同次配对启用 CHAIR_AGENT 活动存储。正常关闭 B 的活动窗口后，原 GUI、桥接和 CLI 均退出；使用相同验收配置目录重开，自动恢复 B 与原目录并运行。
- GUI 使用既有开发启动时指定的隔离 LOCALAPPDATA 验收目录。默认用户目录中旧测试偏好不能作为该 GUI 当前配置的证据。
- Windows 相关回归三个文件、38 项全部通过：desktop-auth、desktop-setup、desktop-bridge。模拟 HTTPS 与真实子进程证据和本段正式 GUI／真实 WSL 服务证据分开记录。
- 浏览器自动化工具在网页配对按钮处拒绝操作，并禁止间接绕过。用户确认继续原生账号配对及文件验收，将网页专用链接唤起与下载入口实际操作留给人工验收；这些项目未标记通过，后续安装关联验收仍须取证。
- 后续发行目标已确认：Windows 10 22H2 x64 与 Windows 11 x64，自包含 ZIP 和用户级 EXE 安装器。本轮不要求签名或公开发布；Windows Sandbox 用于干净环境验收，无 Windows 10 环境，用户接受 Windows 10 实机验收保留为待完成项。

## 2026-10-06：阶段 3B 真实文件业务与缓存回传

- 通过现有 WSL HTTPS 业务 API 在专用委员会 B 提交三个测试文件：中文 UTF-8 内容 45 B、全字节模式二进制 262144 B、空文件 0 B。各上传的 HOST_COMMITTED 回执、待审核 file entry 和 Windows metadata 均核对成功，本地大小和 SHA-256 等于提交内容。
- 三个文件均通过真实批准预览／批准接口进入 PUBLISHED；下载大小与 SHA-256 和 Windows 本地内容一致。正式 GUI 显示公开可见及服务器缓存可用，空文件显示 0 B。
- 在 Windows 同步目录新增中文命名文件，真实 watcher／扫描触发上传，服务器创建 PENDING_REVIEW 文件；版本大小 42 B 和 SHA-256 与本地一致。正式 GUI 显示待审核。
- 第四个网页来源测试提交通过真实驳回接口进入 REJECTED，33 B 内容仍保留于本地；正式 GUI 显示已驳回。验收脚本曾误写预期 32 B，已改为完整内容哈希核对并复查通过，不属于产品错误。
- 对专用委员会已发布的 262144 B 文件执行受控缓存移除：复用服务端安全删除原语，保留 MISSING 缓存追踪，不删除 Windows 权威副本、不修改全局额度。真实下载准备返回 PREPARING，Windows Agent 完成回填；数据库确认缓存 READY、恰好一个 FETCH_BLOB_TO_CACHE 任务、COMPLETED、attempts 1。下载 SHA-256 与原提交一致。
- 本段业务操作来自真实 HTTPS API，与正式 Windows GUI 状态及 NTFS 落盘共同核对；尚未将网页上传控件本身或 LRU 容量策略检查记为通过。网页配对／协议唤起仍按 3A 约定由人工验收。

## 2026-10-06：阶段 3C 批准、冲突恢复与删除

- 真实验收发现首次批准使服务器 revision 变为 2，而本地仍为 1、manifest 为 0，正式文件编辑误走 REVISION_CONFLICT。用户授权修复服务端同步及恢复逻辑；修复包含同名替换的正式目标落盘和历史本地改名路径恢复。
- 冻结修复源码的真实 PostgreSQL 39 项全部通过：首次批准、缺失／过时 manifest、嵌套与改名路径、合并来源、已删除文件、旧 revision／generation、幂等重放、审计失败／不可用内容事务回滚、旧主机和裁决后源文件变化。测试在现有容器网络内各自创建并清理随机数据库，未把未配置数据库时的 skip 算为通过。
- Windows 文件、扫描和恢复测试三个文件 67 项通过；Node Agent 构建通过。
- 经只读 git apply --check 核对后，将服务端修复同步到现有 WSL checkout，重建并更新同一 app 服务。WSL 默认 Docker CLI 配置的 Windows 挂载读取失败，改用任务内独立 CLI 配置连接同一 daemon 完成构建，未更改用户默认配置。
- 重开正式 Windows GUI 加载新核心后，原 REVISION_CONFLICT 禁止 ACCEPT_LOCAL／SAVE_AS_NEW 绕过正式审核；KEEP_SERVER 及同键重放恢复原 262144 B 文件，SHA-256 为 2312394bd99545d9de131c24efb781e765ac1aec243f2ed9347597a793a415e9，本地跟踪 revision 2。
- 新提交的 33 B 文件首次批准后，本地同原 submissions 路径推进到 revision 2；实际本地编辑触发 REVIEW_REQUIRED，KEEP_SERVER 恢复批准字节。
- 再提交不同的 42 B 替换内容，通过同名批准预览及确认后，正式目标推进到 revision 3 并落盘新字节；原 source 路径副本仍在，服务器下载、目标与 source 的 SHA-256 均为 d157d01621695348fbfd03729c05a02407e6e9c3fe85ca1815314ccaf67e8b6b。
- 本地删除既有待审核文件后，服务器记录和本地跟踪一致删除；服务器删除空发布文件后，Windows 字节与跟踪移除，复查未重新创建。
- 断连和活动传输中异常退出的真实文件恢复继续单独验收；本段不能替代这些证据。

## 2026-10-06：阶段 3D 断连与活动上传异常退出

- 在同一 WSL 开发环境停止现有 Caddy，使 Windows 到 HTTPS 入口实际不可达；Agent 运行期间写入 61 B 中文文本，25 秒后本地字节仍在。恢复同一 Caddy 后，只生成一份待审核文件，服务器与本地 SHA-256 均为 7ad1e24ede599dba67c77cf77b292e28fa3cd6b863bbbd4484dcbe5599eb9820。
- 8 MiB 和 16 MiB 尝试在终止前已完成，不计作传输中异常退出证据。最终对专用委员会的 17 MiB UPLOAD_BLOB 领取事务临时延迟 10 秒，在本地 pendingUploads 仍保存 task/request 时强制结束正式 GUI。
- 重开 GUI 后，待上传状态被完成并清理；服务器只有一份 17825792 B 文件，原文件、本地跟踪及服务器下载 SHA-256 均为 0b2d78b54342e937dcfc7a832714d24fe7728c861ce66fa5991c698667933da6。重复检查没有重复条目。
- 延迟触发器与函数已移除；没有把故障注入逻辑写入产品源码。测试使用既有 TLS CA，不关闭证书验证，不创建新开发服务。
- 登录、主机切换、解绑、上传下载、审核发布、缓存回传、冲突、双向删除、断连及活动上传恢复均已有 Windows 实际证据。网页配对入口与协议/关联唤起仍按用户接受的手工验收范围保留；Windows 10 22H2 实机验收待有环境后完成。

## 2026-10-06：阶段 4 发行实现与跨平台回归

- 目标 Windows 10 22H2 x64／Windows 11 x64；用户级 EXE 和 ZIP 均已构建。工具固定 Node 22.23.2、pnpm 10.33.4、Rust 1.98.1、Inno Setup 6.7.3，下载哈希／官方签名已核对。GUI 和 helper 采用静态 CRT，PE 依赖检查没有 VC Runtime/MSVCP 外部依赖，GUI 使用 Windows subsystem 并内嵌图标。
- 首轮候选 Host 隔离 PATH 5 项、Windows Sandbox 7 项真实 smoke 通过。Sandbox 为 Windows 11 Enterprise 10.0.26100 x64，node/pnpm/cargo/rustc/cl 均不可用；ZIP 窗口打开／关闭、用户级安装、重复安装更新、HKCU 命令及卸载保留数据均已执行。最终加固 smoke 还将检查安装后二进制、快捷方式、运行中升级拒绝，待最终重打包复验后记录。
- 发行测试两个文件 8 项通过。PowerShell 5.1 语法、Inno 编译与差异检查通过。新增 GitHub Windows 构建和 Linux AppImage 回归，未推送或触发远程运行。
- 在 WSL 隔离副本完成 Linux contracts／Agent 构建，Node 136 项通过、6 项 Windows 专用测试跳过；完整 Slint 1.17.1／rfd 0.15.4 GUI 与 helper 两个 ELF 构建通过，Rust 10 项通过。登录、连接、文件及覆盖确认四项生产 Slint offscreen fixture 通过。
- Linux 的中文字体只解包到任务目录；文件 fixture 原先点击第二行，现用第一行模型 ID 和生产点击命中结果寻找内点，保留所有交互断言。未修改产品布局或系统字体。本次 Linux 证据是完整 dev 构建与 offscreen 组件回归，不能替代 compositor／portal 原生交互或完整 AppImage 实机验收。
- Windows 10 实机验收按用户确认保留；当前无对应环境。签名与公开发布不在本轮要求内；网页配对／协议实际唤起继续由用户手工验收。
