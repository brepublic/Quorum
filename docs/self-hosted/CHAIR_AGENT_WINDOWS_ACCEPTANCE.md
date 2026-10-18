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

## 2026-10-06：真实冲突比较与服务器版本下载

- 本地正式文件基于 revision 3 修改为 57 B，服务器仍为基准版本时快照核对为本地单独变化。保持待裁决冲突并在网页批准 65 B 同名替换后，原冲突的当前服务器快照推进到 revision 4，原检测时 revision 保留。
- 现有 HTTPS app/Caddy 更新完成；实际浏览器显示本地 v3、服务器 v4、两边大小及 SHA-256，说明服务器修订推进、内容不同且无法确定编辑先后。正式文件建议 KEEP_SERVER 并保留网页审核限制。
- 实际点击“下载服务器版本”得到 65 B 副本，SHA-256 为 4c707c643d9da9ebe0878016977318cb819776d662e9d9109c91bdd478127c38；原 57 B 本地冲突内容保持 SHA-256 4e9d385323d60e9f0eb80d843b09d229b3e83b3990d1d85edfc8e6e2b7281feb，下载没有自动裁决。
- 默认浏览器 1166 px 为并列两栏，无横向溢出；390 px 为单栏，document scrollWidth 375 px，展开 SHA-256 后仍无横向溢出。保存默认和窄屏实际页面截图。已恢复默认 viewport。
- 前端比较与 FilesPanel 共 48 项通过，正式前端构建／TypeScript 通过；服务端快照真实 PostgreSQL 39 项通过。普通正式文件 DELETE 保留服务器允许的 ACCEPT_LOCAL，merged 和原 REVIEW_REQUIRED 继续保护；已知文件卡片使用原始业务名称而不是 content。
- 专用 B 委员会保留一项演示冲突，方便用户直接检查页面；本地／服务器测试副本与结构化证据已导出，没有改动正式会议文件。

## 2026-10-06：最终发行加固与对应源码检查

- 独立复核修复 CI 原生命令失败传播、Linux 打包脚本触发范围，以及卸载时协议与文件关联分别按实际打开命令判断所有权；新增 Sandbox 既有默认值和已被接管关联保留断言。
- 首轮源码包直接复制 registry crate 缺少 directory source 校验文件，不能离线重建。现用完整 Cargo vendor 收录 575 个锁定依赖，575 个 checksum 元数据齐全，完整解析含根项目共 576 包。
- 修正源码 ZIP 27930 条目、109265443 B；独立目录解压、空 CARGO_HOME、offline metadata 通过。按随包原生 Windows／static CRT 参数执行 cargo check --locked --offline --bins，GUI 与 helper 编译检查通过（1 分 38 秒），没有用原 registry 缓存补依赖。
- Source ZIP 未包含 .git／.tools／release／node_modules／.env 条目；随包说明提供无需 .git 的 Contracts、Node Agent 和 Rust 组件重建命令。最终产物将从本批提交后干净工作区重新组装，另记哈希与 Sandbox 最终复验。
- 默认设备名的 Linux 前缀改为通用 Chair computer；既有设备名称属于已注册标签，不自动改写。

## 2026-10-06：最终发行候选与 Sandbox 关闭阻塞

- 从干净提交 0e9d43345b0f4307864b3628feebb226736b296a 离线构建最终候选；release-manifest 的 sourceDirty 为 false。ZIP 45186993 B、Setup 29851167 B、对应源码 109267196 B，三产物哈希核对一致。
- 最终 Host 隔离 PATH smoke 5 项通过。最终 Windows 11 Enterprise 10.0.26100 x64 Sandbox 的 PATH 无 node／pnpm／cargo／rustc／cl。
- 最终 Sandbox 前 8 项通过：三产物哈希、包内 Node、bridge EOF、helper 并发锁／释放、ZIP GUI 正常打开／关闭、用户安装及重复更新、安装后二进制与快捷方式一致、运行中静默升级拒绝且 GUI 存活。
- 安装后 GUI 接收一次正常关闭请求后 15 秒内未退出，测试脚本兜底结束了该测试进程。最终 result.passed=false；卸载、数据保留、已有扩展默认值及重新接管关联的新场景尚未执行。本轮不能作为完整阶段 4 通过证据，前期候选通过不替代这次最终产物验收。
- 只读代码显示 busy 状态会保留窗口，未保存配置也可能要求确认；目前尚未确认哪一分支导致本次超时。按用户要求遇到问题先中断，已提出继续定位／修复／复验的确认，未通过修改测试等待、重发关闭或产品逻辑绕过此失败。
- 专用 Sandbox 保留，现有开发 GUI、宿主注册表和开发服务未因该失败修改。

## 2026-10-07：关闭阻塞定位与修复阶段

- 旧候选在 Sandbox 再次出现安装版关闭超时，另一次出现 ZIP 关闭超时。受控副本记录确认，Node 收到 EOF 后以 0 退出，Rust 收到 bridge-exit 并调用 quit_event_loop 返回 Ok，但 GUI 仍驻留；原生关闭按钮也复现。不能将桥接退出或 quit 返回成功视为 GUI 已退出。
- 初次诊断错误地在 shebang 前插入代码，导致 Node 语法错误；该轮证据无效并单独保留。随后修正注入位置，仅记录状态／事件名称和退出码，没有记录账号或凭据。
- 新 Sandbox 会话一度卡在注销状态，官方 CLI 返回 0x80070520；按用户要求中断，用户重新打开并确认桌面正常后恢复验收。恢复后的环境为 Windows 11 Enterprise 10.0.26100 x64，无 Node/pnpm/Cargo/Rust/MSVC 开发工具。
- GUI 保留 busy 时的关闭意图；操作完成后仍执行未保存配置和 paired-local-recovery 确认。Windows 在桥接完成清理并退出后明确结束 GUI 本身，内核释放锁和 Job handle；Linux 隐藏窗口后退出 Slint 循环。
- GUI smoke 使用可见窗口，等待输入就绪并刷新句柄；不增加关闭重试，不延长原 15 秒退出超时。正式 Rust GUI 的新增忙碌桥接 fixture 通过，EOF 确认发生在受控操作完成后。
- Windows Rust 8 项、发行 8 项通过；WSL 隔离副本完整 Linux GUI/helper 构建及 Rust 10 项通过。修复 GUI 在受控包副本完成关闭、卸载、数据保留、既有默认关联和接管关联保留；副本替换了 GUI 并添加诊断，不能替代最终三产物的完整校验。
- 本阶段提交后从干净源码重新生成最终 ZIP、EXE、对应源码与校验值，正式 Sandbox 结果另记。

## 2026-10-07：最终正式 Windows 发行验收通过

- 最终产物来自干净提交 `f0e485c54f0a90fcce46dfb9614ff4dcfd07a2d8`，release-manifest 的 sourceDirty=false、signed=false。归档位置为 `release/windows-20261007/`；原解压目录被占用导致首轮组装 EBUSY，恢复旧源码包与原校验值一致后，改用新目录完成组装，没有结束用户打开的资源管理器。
- 最终宿主隔离 PATH 6 项通过。全新 Windows 11 Enterprise 10.0.26100 x64 Sandbox 的 node/pnpm/cargo/rustc/cl 均不可用，原始 smoke 脚本与仓库文件 SHA-256 一致，13 项全部通过，result.passed=true；没有替换包内 GUI 或注入诊断代码。
- 13 项覆盖：三产物哈希、捆绑 Node、桥接 EOF、目录锁并发拒绝与释放、ZIP 正常开关、忙碌期间单次关闭等待清理、用户级安装及重复更新、安装后二进制及菜单／桌面快捷方式、运行中升级拒绝且 GUI 存活、安装版正常关闭、卸载清理所属集成并保留私有状态／会议文件、保留既有扩展默认值与 OpenWith、保留被接管的命令／默认值／OpenWith／注册能力。
- 最终源码 ZIP 为 27931 条目，含 575 份 Cargo checksum 元数据；归档 GUI 源码逐字等于验收源码，未包含 .git/.tools/release/node_modules/.env。此前空 CARGO_HOME 的完整离线解析／编译检查作为依赖源码验收证据；本次不把归档检查当作再次完成整套离线构建。
- 最终 PE 依赖仅 Windows 系统库，没有外部 VC Runtime/MSVCP；Windows Rust 8 项、发行测试 8 项、Linux 完整 GUI/helper 构建与 Rust 10 项均通过。本轮未重新运行未改动的服务端业务测试，也未实际触发远程 CI。

| 产物 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| Quorum-Chair-Agent-0.1.0-win-x64.zip | 45186854 | d36957dc2631a04765090fcf5d20f229ad2397144672ac0516c1613b0229d8da |
| Quorum-Chair-Agent-0.1.0-win-x64-Setup.exe | 29848454 | 22e37f63d14fb1930cb15bd66a9ea9fb8019dc210fa272e793006ddfabd8e2ed |
| Quorum-Chair-Agent-0.1.0-win-x64-source.zip | 109280871 | dab53fe1d2a2475cce6e58c4ff9190b91abfe0a8a57618deaffc7f79e7362423 |

- 宿主与 Sandbox 的 JSON 结果、环境信息、最终 manifest／校验值可在发行目录核对；详细运行日志保存在 `.tools/windows/release-final-20261007/`。
- 阶段 4 的本地发行与 Windows 11 干净环境自动验收完成。Windows 10 22H2 实机验收仍按用户确认保留；网页专用配对链接和网页下载关联的实际人工操作沿用 3A 约定，不把注册表命令核对当作网页实际唤起通过。签名、公开发布和推送不在本轮要求内。
