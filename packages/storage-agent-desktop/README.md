# Quorum 主席本地 Agent 桌面外壳

第一版：Rust + Slint 1.17.1，Fluent 控件跟随系统浅色／深色偏好，Linux / GNOME / Wayland；同步核心仍是现有 Node Agent。产品边界见 [已确认取舍](../../.agents/CHAIR_AGENT_GUI.md)。

## 开发启动

从仓库根目录：

```sh
source scripts/wsl-env.sh
pnpm start:storage-agent:desktop
```

需要 Node 22、pnpm、Rust 1.89 或更新的工具链、Linux `flock`（util-linux）、桌面文件选择 portal、`zenity`（覆盖确认弹窗）和 `xdg-open`。当前 checkout 的 Rust 安装于忽略的 `.tools/cargo`、`.tools/rustup`，脚本自动使用；其他 checkout 可使用系统 Rust。首次 Cargo 构建需要联网，之后使用 Cargo.lock 重现依赖。

启动脚本构建 contracts、Agent 和原生窗口。首次启动先确认 Quorum 网址（默认 `https://quorum.sramun.org`）、邮箱及密码；临时密码账号在原生页面修改初始密码，再选择有主席／所有者权限的委员会。暂停委员会可以连接；本地文件变更在委员会恢复后同步。有现有电脑时，须明确确认撤销旧电脑授权。服务器 CA 证书收在网址旁的“连接设置”中；证书不受信任时自动展开。

账号 Cookie 只保存在 Node 桥接内存中，按固定 HTTPS origin 携带 Cookie、CSRF 和 Origin；不跟随重定向。配对完成后请求退出并清除账号状态；退出失败单独提示，长期同步继续使用设备凭据。改变网站必须解除当前连接并重新授权，不把旧设备凭据发给新网站。

网页“配对主席电脑”生成有效期内的一次性配对配置，尝试通过 `quorum-agent://pair` 打开窗口，同时提供 `.quorum-agent` 配置下载。桌面登录页的“更多连接方式 → 打开配对或连接文件…”可选择下载文件或已有私有配置；“使用配对码”进入独立配对表单。浏览器可能要求确认打开外部应用；未安装或未注册时使用下载导入。

配对配置只包含 HTTPS 服务器地址、委员会 ID/名称、一次性配对码、用途和到期时间，不接受设备凭据、私钥、存储路径或 CA 路径。普通下载文件不要求 0600；长期私有配置继续要求独立普通文件、0600 权限。界面显示服务器和建议目录，点击“连接并开始同步”后配对、保存私有配置并启动同步。未配置任何存储的委员会由服务器在同一配对事务中自动启用 CHAIR_AGENT；已有服务器卷/S3 保持原样，不增加跨 provider 迁移。

默认目录取 `xdg-user-dir DOCUMENTS`，不可用或被禁用时回退到 `~/Documents`，在其下创建 `Quorum/<委员会名称>-<编号>`。按服务器与委员会 ID 独立记录编号，预览不占号，确认后独占创建目录，跳过已有路径，删除目录也不回收号码。自选目录必须为空；同一次失败重试复用已选目录。配对后的目录变更仍需完整搬迁和身份校验。

自动生成的私有配置位于 `$XDG_CONFIG_HOME/quorum-agent/configurations/`，缺省为 `~/.config/quorum-agent/configurations/`。`desktop-state.json` 记录网站偏好、最后配置路径和各委员会编号，不保存配对码或凭据。正常启动恢复最后配置及原目录并启动；丢失或无效目录报错，不自动重建同步根目录。解除服务器配对或仅解除本机绑定都会清除自动恢复记录，磁盘配置和文件仍保留。

同步主页提供按当前状态显示的开始／停止、文件状态和存储位置；应用菜单进入“连接与存储”、更换委员会、独立诊断日志、语言选择及委员会网页。查看设置不停止同步，点击“停止同步并编辑”后修改；保存和取消按进入编辑前的运行状态恢复同步。原本停止时保存和取消仍保持停止。关闭窗口停止同步进程。

最近连接和缓存状态的更新时间各自超过 30 秒后才显示，使用“31 秒前”“2 分钟前”“1 小时前”等相对时间，英文使用对应单复数。正好 30 秒、未来时间或无有效记录时不显示；停止接收快照后仍随时间更新，恢复新记录后隐藏。该阈值只影响时间提示，不更改同步间隔或连接判断。

同一 Linux 用户只运行一个桌面窗口，通过用户私有目录中的 Unix socket 转交再次打开的文件/链接，文件锁保护窗口实例；原有同步目录 `flock` 继续保护 CLI 与桌面核心。其他委员会配置不会静默替换已配对身份，需先停止并解除本机绑定。带未保存输入时使用居中放弃确认。

## 配置约束

- 服务器地址为 HTTPS origin，不含路径、查询或账号。
- 已配对配置禁止直接更改服务器 origin。通过设置中的“解除连接…”先处理当前绑定，再重新登录连接。
- CA 证书用于原生登录的 HTTPS 请求，并通过同步子进程 `NODE_EXTRA_CA_CERTS` 设置。修改后需重新启动 Agent，不修改系统证书。
- 证书选择器默认筛选 `.crt`／`.pem`／`.cer`，配置导入默认筛选 `.quorum-agent`／`.json`；筛选名称跟随界面语言，均可切换“所有文件”。后缀筛选用于查找文件，导入后的内容及权限检查保持不变。
- 扫描间隔为 1–3600 秒，默认 30 秒；文件变化仍会唤醒同步。
- 配置保存前须停止进程。新目录必须有同设备元数据；目录变更还校验所有跟踪/待上传文件，不能用部分副本替代原目录。GUI 不搬迁、不删除用户目录。
- 私有配置和 CA 必须在同步目录外。

“保存设置”和“另存为”在停止时可用，无需先配对。未配对文件只保存服务器地址、存储目录、CA 路径、扫描间隔、设备名称，不保存一次性配对码。导入后进入独立配对码页面，不能启动；配对成功后同一文件更新为完整配置。保存未配对设置不连接服务器，不要求存储目录已创建。

“另存为”选择目标配置路径，已有文件经确认后覆盖；保存后切换到新文件，原路径文件保留。已配对配置的副本仍是同一设备身份。导入未配对配置不会撤销先前加载的设备授权。

“更换委员会…”和“解除连接…”位于设置页的当前连接信息下，运行中即可点击；应用菜单也提供“更换委员会…”快捷入口。确认前不停止同步；确认后先停止同步并等待目录锁释放，再请求原服务器撤销设备授权，成功后返回登录页选择新的委员会。更换委员会的确认框明确说明后续登录步骤，停止和解除过程中显示对应进度文字。失败时可重试，也可显式选择“仅解除本机绑定”返回登录页（无需原委员会或服务器可用）。两种解绑方式均保留界面中的配置路径、服务器地址、存储目录、CA 证书、扫描间隔和设备名称，清除已加载身份和旧委员会状态；本机解绑不表示服务器授权已撤销，旧配置仍可能连接。两种方式都保留旧配置与存储文件；重新配对时可确认覆盖原配置文件，选择新的存储目录，并从目标服务器网页取得一次性配对码。

系统标题栏和页面内标题均跟随语言，中文为 `Quorum 主席 Agent`，英文为 `Quorum Chair Agent`。登录表单限制为 440px 宽，配置／配对表单限制为 680px 宽；表单和确认按钮在同一个滚动区域，按钮紧随相关内容。路径使用可选择的只读文字，变更通过系统目录／文件选择器。同步页、设置页和诊断日志各自保留所属操作；语言使用登录页底部及应用菜单中的“Language / 语言”入口。窗口默认 960×720，最小 760×600。

未保存修改显示“未保存”，启动、重启和撤销授权前须保存或重新导入。导入其他配置及关闭窗口前会确认是否放弃未保存的设置或配对码；取消保留输入。保存和失败重试保留配对码，配对成功或成功导入后清空。保存、导入、配对和日志导出提供结果反馈。操作成功使用带勾号、绿色底色和关闭按钮的独立提示条；仅解除本机绑定但未确认服务器撤权时使用警示提示，失败使用错误提示，与说明文字区分。

错误显示失败步骤和明确原因；日志记录白名单操作、步骤、错误码，不记录原始异常消息、服务器响应体或配对码。CLI 的配对失败通过有限长结构化错误传回 GUI，保留 TLS、网络、服务器配对和本地写入错误区别。CA 字段用于服务器证书未受系统信任的情况，服务地址应指向提供 Agent API 的 HTTPS 服务，不是 Vite 开发前端。

## 状态与接口

新增 `GET /api/v1/storage-agent/file-status?after=<file UUID>`，使用现有 `QuorumAgent` 认证与 `x-storage-lease-generation`。每页最多 200 项，服务器从当前设备身份推导委员会，不接受任意委员会 ID。查询最新委员会名称、暂停状态、实际存储方式以及文件状态、当前内容、缓存元数据，保留删除文件名；不下载文件，不触发回传，不返回 storage key，不新增数据库表。

**需要部署更新后的服务器才有审核/缓存状态。** 本次验收已重建本机 `quorum-dev` 应用，其他部署仍需自行更新。旧服务器上同步协议仍可工作，但 GUI 的文件状态查询会显示连接/状态异常。

GUI 状态查询约每 3 秒一次，10 秒查询超时；断网标记缓存未知。状态是观察快照，不承诺服务器之后仍保有缓存。当前版本对应的本地文件必须通过大小和哈希校验才显示就绪。上传进度是 Agent 已读取并交给 HTTP 流的字节数，不等同服务器确认；下载是已接收字节数。100% 后仍有校验/提交阶段。回传与普通上传分别显示。

控制协议：Rust → `desktop-bridge.js` 标准输入逐行 JSON（open/restore/setup-pair/load/pair/save/save-as/unpair/unpair-local/start/stop/restart）；桥接器 → Rust 标准输出 JSON（setup/defaults/config/unpaired/completed/busy/state/snapshot/log/error）。同步进程标准输出仅发送展示快照；内部日志走标准错误并被桥接器过滤。进度最多约 10 次/秒。展示快照不含凭据、私钥、claim token、哈希或正文。日志保留最近 1000 行；复制/导出不含文件名、用户路径或秘密。

## 验证

```sh
source scripts/wsl-env.sh
pnpm --filter @quorum/contracts build
pnpm --filter @quorum/storage-agent build
pnpm exec vitest run packages/storage-agent/src server/src/http/stage7-http.test.ts server/src/modules/storage-agent/task-service.test.ts
# 按 AGENTS.md 配置 TEST_DATABASE_ADMIN_URL，必须是临时数据库专用服务：
pnpm exec vitest run server/src/modules/storage-agent/postgres.integration.test.ts -t 'returns only current-host'
```

`desktop-bridge.test.ts` 使用真实编译后的子进程与临时 HTTPS 模拟服务器，需要 `openssl` 和本机监听权限；不访问既有 Agent 或生产服务器。数据库测试未配置时明确 skip。

原生布局烟雾测试（模拟数据，不读取用户配置）：

```sh
cargo run --locked --manifest-path packages/storage-agent-desktop/Cargo.toml --example ui-preview
cargo run --locked --manifest-path packages/storage-agent-desktop/Cargo.toml --example ui-preview -- --settings
```

约 800ms 后截取窗口自身到 `/tmp/quorum-agent-ui.ppm` 并退出，可用 `QUORUM_UI_CAPTURE` 指定输出。测试中文显示不等于实际中文输入法、目录选择 portal、真实会议端到端验收；这些需在目标桌面继续人工确认。

## 打包

运行 `pnpm release:storage-agent:desktop -- --offline` 可使用现有 Node 运行时缓存组装 `release/storage-agent-desktop/`；缺少缓存时去掉 `--offline`。Cargo 首次仍需下载依赖。程序位于该目录的 `quorum-storage-agent-desktop`，无需另装 Node，但仍使用当前系统的桌面库和 portal。

也可将 release 编译的 `quorum-storage-agent-desktop` 放到现有 Linux Agent 自包含发布包根目录（与 `runtime/node`、`app/desktop-bridge.js` 相邻）。开发时脚本用 `QUORUM_AGENT_NODE`、`QUORUM_AGENT_BRIDGE` 指定当前构建。第一版仅验收当前 Linux 环境；未声称 Windows/macOS 可直接发行。

### Linux 桌面注册

将发布目录放在稳定位置后运行 `./register-desktop.sh`（或程序的 `--register`）。程序正常启动也会更新当前用户的注册。注册使用 `xdg-mime`、`update-mime-database` 和 `update-desktop-database`，不需要 root。

统一应用标识为 `org.quorum.ChairAgent`：Wayland app_id、X11 WM_CLASS、`org.quorum.ChairAgent.desktop` 的 StartupWMClass 及图标名一致。图标作为 SVG 内嵌窗口并安装到用户的 hicolor 图标目录；桌面入口的 `Icon` 直接引用所安装文件的绝对路径，避免运行中的桌面仍通过旧图标主题缓存查找。注册 `quorum-agent:` 协议及 `.quorum-agent` 文件关联，桌面入口固定 Node/bridge 路径，因此开发启动也能正确接收浏览器链接。移动发布目录后重新注册。

项目沿用 GPLv3，Slint 按其 GPLv3 选项使用；Cargo.lock 固定依赖。二进制发行须附源码与相应第三方许可。

## 界面语言

窗口内可切换 English / 简体中文，选择保存于 `$XDG_CONFIG_HOME/quorum-agent/desktop-language`（缺省 `~/.config/quorum-agent/desktop-language`）。首次打开按 LANG 选择。切换保留未保存设置、文件名、路径、传输状态和配对身份；语言不写入私有 Agent 配置。Node 与桌面同包更新，内部状态使用标识，服务器 Agent 协议保持 2。

桌面保存、另存为和配对写入已有配置文件前均弹窗确认目标路径；取消不写入，确认后以 0600 权限原子替换。配对使用临时配置，服务器拒绝配对时保留原文件。目录、符号链接及非独立普通文件不能作为覆盖目标。

## 本次验证与边界

账号 HTTPS 与真实 Node 子进程测试覆盖原生登录、临时密码页面分流、目录确认、配对、退出、证书验证、错误响应及账号凭据不落盘。配对后的本机保存失败通过私有进程通道保留已收到的设备身份；保持窗口并重试本机保存，不再次申请配对。该暂存身份仅在当前进程中，完全无法保存时不能保证关闭窗口后的恢复。

完整验收记录见 `docs/self-hosted/CHAIR_AGENT_UX_ACCEPTANCE.md`。Slint 样例数据截图仅检查布局，不能替代真实选择器、键盘输入、桌面任务栏及文件传输验收。


## 布局与交互回归预览

`examples/ui-preview.rs` 复用正式 Slint 组件，只注入样例显示数据，不读写用户配置，不连接账号或同步文件。`--offscreen` 使用 Slint 自带软件渲染器得到精确尺寸，避免窗口管理器的平铺影响。默认 960×720，`--small` 为 760×600；`--light`／`--dark` 强制预览主题，正式程序仍跟随系统。

```sh
source scripts/wsl-env.sh
export CARGO_HOME="$PWD/.tools/cargo"
export RUSTUP_HOME="$PWD/.tools/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
cargo build --locked --manifest-path packages/storage-agent-desktop/Cargo.toml --example ui-preview
QUORUM_UI_CAPTURE=/tmp/quorum-login.ppm packages/storage-agent-desktop/target/debug/examples/ui-preview --offscreen --login --dark --exercise-login
QUORUM_UI_CAPTURE=/tmp/quorum-settings.ppm packages/storage-agent-desktop/target/debug/examples/ui-preview --offscreen --settings --paired --edit --advanced --small --en --light --scroll-bottom
```

预览页面参数包括 `--login`、`--password`、`--committees`、`--manual`、`--setup`、`--settings --paired`、`--logs`，无页面参数为同步页。`--options`、`--network`、`--transfer`、`--error`、`--empty`、`--offline`、`--language` 用于对应状态。`--scroll-bottom` 通过滚轮事件检查滚动后内容。

`--fresh-times`、`--stale-times`、`--stale-cache` 分别检查两项时间均新鲜、均超时、仅缓存超时的显示，可与 `--small`、`--en`、`--light`／`--dark` 组合。

`--exercise-login` 必须与默认尺寸的 `--offscreen --login` 配合，通过真实 Slint 鼠标／键盘事件检查展开、空格激活、文件导入／手动入口回调、邮箱 → Tab → 密码 → Enter、语言切换、Escape 关闭、保留输入及应用菜单的设置／日志／网页回调。回调仅记录，不请求服务器；这些检查不代表系统输入法、文件选择器或完整原生账号连接已经验收。


`--switch-committee`、`--stopping`、`--disconnected-notice`、`--local-disconnect-notice` 可预览更换确认、停止中及两种解除结果。`--exercise-connection` 与默认尺寸 `--offscreen --settings --paired --dark` 配合，通过 Slint 实际鼠标／键盘事件检查两个连接入口、解除按钮的空格／回车激活、忙碌及未保存时禁止操作、运行中确认、操作期间禁止取消以及提示条关闭；回调只记录，不调用 Node 桥接。

停止同步同时取消服务器事件连接的响应读取器，随后等待同步清理并释放目录锁。保留原有 15 秒异常退出兜底，正常空闲停止不等待下一条服务器事件。对本机真实 HTTPS 服务的三轮发布包验收为 134／60／81 毫秒，均记录正常停止；该结果不承诺大文件正在校验等所有场景的固定耗时。
