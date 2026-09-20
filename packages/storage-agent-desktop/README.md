# Quorum 主席本地 Agent 桌面外壳

第一版：Rust + Slint 1.17.1，统一 Fluent 浅色样式，Linux / GNOME / Wayland；同步核心仍是现有 Node Agent。产品边界见 [已确认取舍](../../.agents/CHAIR_AGENT_GUI.md)。

## 开发启动

从仓库根目录：

```sh
source scripts/wsl-env.sh
pnpm start:storage-agent:desktop
```

需要 Node 22、pnpm、Rust 工具链、Linux `flock`（util-linux）、桌面文件选择 portal 和 `xdg-open`。当前 checkout 的 Rust 安装于忽略的 `.tools/cargo`、`.tools/rustup`，脚本自动使用；其他 checkout 可使用系统 Rust。首次 Cargo 构建需要联网，之后使用 Cargo.lock 重现依赖。

启动脚本构建 contracts、Agent 和原生窗口。窗口最初不启动同步：导入已有配置或输入配对信息，再点击“启动”。已有旧版终端 Agent 必须先退出；旧版不参加新版本的目录进程锁。新版本 CLI 与 GUI 通过同一个内核文件锁防止重复运行。

配置文件栏初始为空；可以先保存未配对设置；未填写路径时“保存设置”会打开保存位置选择框。选择已有配置后点击“导入”；秘密仍由 Node 读取，不发送给 Rust 界面。关闭窗口等待 Agent 退出；异常关闭 GUI 会关闭管道，控制进程随之停止 Agent。停止宽限期为 15 秒，超时强制结束并保留现有恢复机制。

## 配置约束

- 服务器地址为 HTTPS origin，不含路径、查询或账号。
- 修改服务器 origin 前，在不发送设备凭据的情况下验证两个地址的 TLS 证书完全一致。证书不同、旧地址无法连接时拒绝修改；这是保守的同服务地址切换限制，不提供跨服务器迁移；连接其他服务器须先解除配对，再用新的配置路径和存储目录配对。证书一致不证明数据库相同，用户仍须遵守“同一服务”的已确认约束。
- CA 证书只通过子进程 `NODE_EXTRA_CA_CERTS` 设置。修改后需重新启动 Agent，不修改系统证书。
- 扫描间隔为 1–3600 秒，默认 30 秒；文件变化仍会唤醒同步。
- 配置保存前须停止进程。新目录必须有同设备元数据；目录变更还校验所有跟踪/待上传文件，不能用部分副本替代原目录。GUI 不搬迁、不删除用户目录。
- 私有配置和 CA 必须在同步目录外。

“保存设置”和“另存为”在停止时可用，无需先配对。未配对文件只保存服务器地址、存储目录、CA 路径、扫描间隔、设备名称，不保存一次性配对码。导入后显示“未配对”，不能启动；配对成功后同一文件更新为完整配置。保存未配对设置不连接服务器，不要求存储目录已创建。

“另存为”选择一个不存在的配置文件路径；保存后切换到新文件，原文件保留。已配对配置的副本仍是同一设备身份。导入未配对配置不会撤销先前加载的设备授权。

“解除配对”使用居中模态弹窗确认，并请求原服务器撤销当前设备授权。失败时可重试，也可显式选择“仅解除本机绑定”返回配对表单（无需原委员会或服务器可用）。仅本机解绑保留界面中的配置路径、服务器地址、存储目录、CA 证书、扫描间隔和设备名称，清除已加载身份和旧委员会状态；本机解绑不表示服务器授权已撤销，旧配置仍可能连接。两种方式都保留旧配置与存储文件；重新配对时填写新的私有配置路径、选择新的存储目录，并从目标服务器网页取得一次性配对码。

系统标题栏使用 ASCII 标题 `Quorum Chair Agent`，避免标题栏字体缺少中文字形；页面内标题跟随界面语言。设置表单支持滚动；配对码输入框、配对及保存按钮固定在底部，错误栏与日志展开时仍可访问。

未保存修改显示“未保存”，启动、重启和撤销授权前须保存或重新导入。导入其他配置及关闭窗口前会确认是否放弃未保存的设置或配对码；取消保留输入。保存和失败重试保留配对码，配对成功或成功导入后清空。保存、导入、配对和日志导出提供结果反馈。

错误显示失败步骤和明确原因；日志记录白名单操作、步骤、错误码，不记录原始异常消息、服务器响应体或配对码。CLI 的配对失败通过有限长结构化错误传回 GUI，保留 TLS、网络、服务器配对和本地写入错误区别。CA 字段用于服务器证书未受系统信任的情况，服务地址应指向提供 Agent API 的 HTTPS 服务，不是 Vite 开发前端。

## 状态与接口

新增 `GET /api/v1/storage-agent/file-status?after=<file UUID>`，使用现有 `QuorumAgent` 认证与 `x-storage-lease-generation`。每页最多 200 项，服务器从当前设备身份推导委员会，不接受任意委员会 ID。只查询文件状态、当前内容、缓存元数据，保留删除文件名；不下载文件，不触发回传，不返回 storage key，不新增数据库表。

**需要部署更新后的服务器才有审核/缓存状态。** 本次开发不会自动重建现有 Compose 应用。旧服务器上同步协议仍可工作，但 GUI 的文件状态查询会显示连接/状态异常。

GUI 状态查询约每 3 秒一次，10 秒查询超时；断网标记缓存未知。状态是观察快照，不承诺服务器之后仍保有缓存。当前版本对应的本地文件必须通过大小和哈希校验才显示就绪。上传进度是 Agent 已读取并交给 HTTP 流的字节数，不等同服务器确认；下载是已接收字节数。100% 后仍有校验/提交阶段。回传与普通上传分别显示。

控制协议：Rust → `desktop-bridge.js` 标准输入逐行 JSON（load/pair/save/save-as/unpair/unpair-local/start/stop/restart）；桥接器 → Rust 标准输出 JSON（config/unpaired/completed/busy/state/snapshot/log/error）。同步进程标准输出仅发送展示快照；内部日志走标准错误并被桥接器过滤。进度最多约 10 次/秒。展示快照不含凭据、私钥、claim token、哈希或正文。日志保留最近 1000 行；复制/导出不含文件名、用户路径或秘密。

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

项目沿用 GPLv3，Slint 按其 GPLv3 选项使用；Cargo.lock 固定依赖。二进制发行须附源码与相应第三方许可。

## 界面语言

窗口内可切换 English / 简体中文，选择保存于 `$XDG_CONFIG_HOME/quorum-agent/desktop-language`（缺省 `~/.config/quorum-agent/desktop-language`）。首次打开按 LANG 选择。切换保留未保存设置、文件名、路径、传输状态和配对身份；语言不写入私有 Agent 配置。Node 与桌面同包更新，内部状态使用标识，服务器 Agent 协议保持 2。
