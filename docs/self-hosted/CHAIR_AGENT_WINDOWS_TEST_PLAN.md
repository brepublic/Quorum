# Windows Chair Agent 测试与验收流程

适用范围：合并提交 `6a0b3da` 及后续版本的 Windows x64 Agent，重点验证服务器卷迁移、源副本清理、批准、同名替换、冲突处理和窗口关闭。本文是执行清单，不是通过记录；执行结果写入 [Windows 验收记录](CHAIR_AGENT_WINDOWS_ACCEPTANCE.md)。

## 1. 环境与版本

- [ ] Windows 11 x64；若发布声明支持 Windows 10 22H2，另用 Windows 10 实机执行本流程。Windows 11／Sandbox 结果不能代替 Windows 10。
- [ ] 记录 Windows 版本、缩放比例、文件系统、Git 提交编号、工具版本、产物哈希和执行日期。Windows 与服务器使用同一待验收版本，工作区改动另行记录。
- [ ] 使用本地 NTFS 测试目录，路径包含中文和空格；仅操作专用验收委员会及其文件。
- [ ] 复用已有 Quorum 开发服务器。Windows 与 WSL 同机时沿用既有 WSL 服务，不另建 Windows Docker 或第二套开发服务器；若服务器在另一台 Linux 机器，使用实际可达的 HTTPS 地址，不把 Windows 的 localhost 当作那台机器。
- [ ] 先确认实际 HTTPS API 地址、可信 CA 和登录账号。端口 80 可能重定向；5173 是网页开发入口，不直接作为 Agent HTTPS origin。
- [ ] 数据库升级历史末三项为 `87 chair_conflict_replacements`、`88 chair_storage_migration`、`89 migrated_file_version_integrity`。本次 Linux 开发库已重建，旧测试账号和委员会不再存在，按初始化流程准备新账号。

在 Windows 原生 PowerShell、仓库根目录执行。路径按实际位置替换：

```powershell
Set-Location D:\Projects\Quorum
$ErrorActionPreference = 'Stop'
. .\scripts\windows-env.ps1
git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot read revision' }
git status --short
node --version
pnpm --version
rustc --version
cargo --version
.\scripts\check-windows-toolchain.ps1
```

工具缺失按 [环境准备](CHAIR_AGENT_WINDOWS_SETUP.md) 安装，版本以仓库锁文件为准。`check-windows-toolchain.ps1` 必须实际编译并运行最小 Rust 程序。Node/pnpm 依赖和 Rust 产物使用 Windows 自己的目录，不复用 Linux 的 node_modules 或 target。

```powershell
pnpm install --frozen-lockfile --store-dir .tools/windows/pnpm-store
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
```

## 2. 自动测试与正式程序构建

先构建平台辅助程序，再运行依赖它的 ACL、目录锁和进程测试。Git 自带 OpenSSL 必须可用，路径不同则调整下例：

```powershell
$env:PATH = 'C:\Program Files\Git\usr\bin;' + $env:PATH
openssl version
if ($LASTEXITCODE -ne 0) { throw 'OpenSSL unavailable for HTTPS tests' }
pnpm --filter @quorum/contracts build
if ($LASTEXITCODE -ne 0) { throw 'Contracts build failed' }
pnpm --filter @quorum/storage-agent build
if ($LASTEXITCODE -ne 0) { throw 'Agent build failed' }
cargo build --locked --manifest-path packages/storage-agent-desktop/Cargo.toml --bins
if ($LASTEXITCODE -ne 0) { throw 'Native GUI/helper build failed' }
$env:QUORUM_AGENT_PLATFORM = (Resolve-Path 'packages/storage-agent-desktop/target/debug/quorum-agent-platform.exe').Path
$env:QUORUM_AGENT_NODE = (Get-Command node.exe).Source
pnpm exec vitest run scripts/storage-agent-release.test.ts scripts/storage-agent-windows-release.test.ts packages/storage-agent/src
if ($LASTEXITCODE -ne 0) { throw 'Agent or packaging tests failed' }
cargo test --locked --manifest-path packages/storage-agent-desktop/Cargo.toml --bins
if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed' }
```

验收时核对测试名称与结果，不沿用历史测试数量：

| 范围 | 必须覆盖的行为 |
| --- | --- |
| 文件保存 | 迁移历史内容保存、重复执行、回执丢失后复用；短内容、长内容、哈希不符和文件同步失败不能发布目标 |
| 迁移恢复 | 网络中断保留领取状态；缺失／损坏副本拒绝复核；迁移私有目录不被当作普通新文件上传 |
| 文件批准 | 批准后修订同步；批准前本地已有编辑、上传未结束、不同路径／内容变化不被错误覆盖 |
| Windows 平台 | 私有 ACL 和所有者、目录锁、大小写／短路径别名、junction 拒绝、文件占用时原子替换失败保留旧内容 |
| 进程 | 子进程及孙进程退出、目录锁释放、重复启动拒绝、桥接正常与异常退出 |
| 关闭规则 | Rust 的 `migration_discards_queued_close_while_short_operations_still_close_after_confirmation` 必须通过 |

所有失败须处理或明确标为阻塞。Windows 专用测试不得作为“正常跳过”忽略；Linux 专用用例在 Windows 跳过需注明原因。Rust 关闭测试使用正式 Slint 组件和内存窗口，不是 Windows 原生窗口验收。

服务端 PostgreSQL 回归在已有 Linux/WSL checkout 中运行，测试库与开发业务库分开：

```bash
source scripts/wsl-env.sh
pnpm --filter @quorum/contracts build &&
pnpm self-host:test-db:up &&
TEST_DATABASE_ADMIN_URL=postgresql://quorum_test:quorum_test@127.0.0.1:55432/postgres \
  pnpm test:self-host:integration --maxWorkers=2 --minWorkers=1
# 记录上一条命令的退出码和日志后，关闭本次启动的测试服务：
pnpm self-host:test-db:down
```

数据库测试须实际运行，未配置测试地址而全部 skip 不算通过。确认涵盖空库升级、远端 0087 升级至 0089、重复升级、迁移清理后批准／替换／冲突恢复、副本不可用时回滚。

## 3. 原生登录、证书与文件基线

```powershell
$quorumOrigin = 'https://localhost' # 按实际服务器修改
$quorumCa = 'D:\Certificates\quorum-root.crt' # 服务器实际使用的 CA
curl.exe --cacert $quorumCa --fail --show-error "$quorumOrigin/health/ready"
if ($LASTEXITCODE -ne 0) { throw 'HTTPS readiness failed' }
pnpm start:storage-agent:desktop:windows
```

- [ ] 使用正式 GUI 登录、选择委员会、选择 CA、配对；既有服务器卷不会因配对立即切换。
- [ ] 中文输入法、复制粘贴、Tab 焦点、文件选择器、打开目录、中英文显示正常；记录 100%／125%／150% 缩放及窄窗实际检查结果。
- [ ] 未提供必要 CA 或使用错误 CA 时连接失败；禁止使用 `-k` 或关闭 TLS 验证来通过测试。
- [ ] 准备至少三个专用委员会：正常迁移、取消迁移、故障／恢复，避免后续流程互相改变前提。
- [ ] 正常迁移委员会包含：待审核文件、已发布文件、同名替换待审核文件、带两个历史版本的文件、空文件、中文／空格路径文件、可持续传输的大文件。文件大小不超过本机配置上限；小文件迁移瞬间完成时不能算作“传输中断”验收。
- [ ] 原始文件保存在 Agent 目录之外，记录文件 ID、版本 ID、字节数及 SHA-256。下载和 Windows 落盘结果均与相应原始版本比较。

```powershell
Get-Item -LiteralPath 'D:\Quorum验收源文件\工作文件.txt' | Select-Object Name, Length
Get-FileHash -Algorithm SHA256 -LiteralPath 'D:\Quorum验收源文件\工作文件.txt'
```

## 4. 正常迁移、确认和源副本清理

1. 网页在服务器卷存储下启动“迁移至主席电脑”，确认 Agent 在线且支持迁移。
2. 复制期间检查网页和 GUI 的整体／当前文件进度；GUI 迁移弹窗遮住文件列表，Escape、Enter 和关闭按钮均不能中断迁移。进度 100% 不等于已复核成功。
3. 等待网页确认阶段，确认仍使用服务器卷，服务器原文件仍可下载；关闭 Agent 窗口仍被阻止。
4. 网页确认迁移，观察本机内容复核、活动存储切换至主席电脑、迁移完成、弹窗收起。**窗口须保持打开，不能因先前点击关闭而退出。**
5. 按迁移项检查 `.quorum-blobs/<target_blob_id>` 的真实文件大小及 SHA-256；当前展示路径与不可变内容副本分别核对，历史内容也须存在。
6. 等待服务器清理任务完成。由服务器操作员只读核对源 blob 为 `DELETED`、对应服务器卷文件实际不存在、历史版本记录仍在、目标副本仍为 `COMMITTED`。不能只看网页“完成”便认定物理清理完成，也不要手工删除源文件替代清理任务。
7. 再次同步和重启 Agent，确认没有重复上传、重复迁移副本或丢失历史内容。服务器下载缓存独立核对，不作为旧服务器卷副本残留的证据。

服务器核对时，以当前验收迁移 ID 筛选，连接既有开发库；下例为只读 SQL：

```sql
SELECT m.id, m.status, m.source_binding_id, m.target_binding_id,
       c.active_storage_binding_id
FROM storage_migrations m JOIN committees c ON c.id=m.committee_id
WHERE m.id='<本次迁移 UUID>';
SELECT i.content_blob_id, i.target_blob_id, i.verified_at,
       s.storage_key AS source_key, s.durability_state AS source_state,
       t.durability_state AS target_state, i.size_bytes,
       encode(i.sha256,'hex') AS sha256
FROM storage_migration_items i
JOIN file_blobs s ON s.id=i.source_blob_id
JOIN file_blobs t ON t.id=i.target_blob_id
WHERE i.migration_id='<本次迁移 UUID>';
```

根据查询所得源 key 在服务器容器的实际 `QUORUM_STORAGE_PATH/server-volume` 下只读检查文件；不要猜测文件路径或递归清空目录。

## 5. 清理源副本后的批准与冲突

以下操作必须在第 4 节确认源文件实际删除后执行：

| 编号 | 操作 | 通过条件 |
| --- | --- | --- |
| A1 | 批准迁移前已有的待审核文件 | 成功发布；Agent 修订同步，内容哈希不变；无 `FILE_CONTENT_UNAVAILABLE` 或重复任务错误 |
| A2 | 批准另一份同名替换文件 | 正式目标获得新版本和新内容，文件身份及历史版本保留；原提交路径按既有规则保留；网页下载与 Windows 目标文件哈希一致 |
| A3 | 编辑已发布的本地文件，产生冲突后选择保留服务器版本 | 界面比较的是当前服务器版本；Windows 实际文件恢复为该版本，冲突消失；不能因源 blob 已删除而失败 |
| A4 | 再次编辑已发布文件，选择保留本地版本 | 审核规则允许时生成正确新版本，名称／类型／发布状态保留；网页下载等于本地编辑字节；禁止的场景仍拒绝绕过审核 |
| A5 | 比较页面打开后，另一路批准新版本，再提交旧裁决 | 旧裁决被拒绝或要求重新确认，不能覆盖后来批准的版本 |
| A6 | 下载历史版本并重复同步 | 下载内容匹配原始哈希；不重复创建逻辑文件、版本或已完成的裁决 |

批准阶段校验的是数据库记录的副本状态、大小和哈希，**不会即时远程读取 Windows 磁盘**。数据库副本缺失／删除中／大小或哈希不符的拒绝行为由 PostgreSQL 回归覆盖。实际磁盘损坏由迁移复核或 Agent 读写校验发现，按下一节验收，不能把两种检查混为一谈。

## 6. 中断、损坏、取消与重启

仅针对专用故障委员会和明确记录的副本操作，每项重新准备满足前提的数据。

| 编号 | 步骤 | 通过条件 |
| --- | --- | --- |
| R1 | 在迁移字节仍增长时断开测试连接，确认中断后恢复连接 | 未确认前仍使用源存储；恢复后继续／重试未完成内容，已确认内容不重复上传 |
| R2 | 活动迁移中用任务管理器结束本次 GUI，记录相关 GUI／桥接／CLI PID，再重新打开 | 子进程结束、目录锁可重新取得；使用原配置继续，最终全部哈希正确；传输已完成才终止的不算通过 |
| R3 | 复制完成、尚未网页确认时，用任务管理器结束本次 Agent 及其子进程，再删除一个指定 `.quorum-blobs` 副本；重开并确认 | 复核失败、不切换、不清理服务器源文件；按现有重试流程重新复制、复核，最终才允许切换 |
| R4 | 重复 R3，但把指定副本改成同长度错误内容 | 哈希校验发现损坏；不能只靠大小通过；重试后内容恢复 |
| R5 | 已完成迁移后退出并重启 Agent，再重启 Windows | 当前与历史内容重新读取仍正确、无残留锁；批准和冲突恢复继续成功。正常重启不等于突然断电持久性验收 |
| R6 | 复制中、等待网页确认时分别取消迁移 | 源存储继续可用；目标副本由既有清理任务处理；不删除源内容，窗口不因旧关闭请求退出 |
| R7 | 迁移中撤销／转移设备授权 | 旧设备不能完成切换；服务器源内容保留；新设备按现有流程重新建立有效迁移 |

断连优先作用于 Windows 测试进程／连接。若采用停止既有开发 Caddy，先确认只影响本机验收，并在该项结束后恢复同一服务。严禁以删除缓存或服务器源文件制造“网络中断”。

## 7. 窗口关闭专项

- [ ] 普通短操作忙碌时只发一次关闭请求：操作完成后检查未保存内容；无修改正常退出，有修改出现确认，取消后窗口继续使用。
- [ ] 正在复制、等待网页确认、复核、失败／断线时分别点击关闭：窗口和迁移保持，关闭请求不排队。
- [ ] 完成和取消迁移后等待至少 5 秒：不会自动退出；此后重新点击关闭才正常退出。
- [ ] 确认 GUI、桥接、CLI 和 helper 的本次进程退出，重新启动能取得目录锁；仅窗口消失不算退出完成。

“先积压关闭请求，再开始迁移”不应依赖人工抢短操作的时间。第 2 节 Rust 测试覆盖顺序，下面用正式 Windows GUI 和受控桥接消息复查原生窗口。**受控桥接只发送状态，不复制文件，不代替第 4—6 节真实迁移。**

在独立 PowerShell 会话运行以下内容。它隔离本次配置，只控制它自己启动的 GUI，结束后恢复环境变量：

```powershell
. .\scripts\windows-env.ps1
$quorumProbe = Join-Path $PWD ('.tools/windows/close-check-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $quorumProbe | Out-Null
$quorumBridge = Join-Path $quorumProbe 'bridge.cjs'
@'
const fs = require('node:fs');
const path = require('node:path');
const send = value => console.log(JSON.stringify(value));
let last = '';
send({event:'busy',value:true});
setInterval(() => {
  const file = path.join(__dirname, 'phase');
  if (!fs.existsSync(file)) return;
  const phase = fs.readFileSync(file,'utf8').trim();
  if (!['COPYING','READY_TO_CONFIRM','FAILED','COMPLETED','CANCELLED'].includes(phase)) return;
  if (phase === last) return;
  last = phase;
  send({event:'snapshot',connected:true,files:[],migration:{status:phase,
    progress:{online:true},completedItems:0,totalItems:1}});
  send({event:'busy',value:false});
}, 50);
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
'@ | Set-Content -LiteralPath $quorumBridge -Encoding ascii
$quorumSavedEnvironment = @{}
foreach ($quorumName in @('LOCALAPPDATA','QUORUM_AGENT_NODE','QUORUM_AGENT_BRIDGE','QUORUM_AGENT_PLATFORM')) {
    $quorumSavedEnvironment[$quorumName] = [Environment]::GetEnvironmentVariable($quorumName, 'Process')
}
$quorumProcess = $null
try {
    $env:LOCALAPPDATA = Join-Path $quorumProbe 'profile'
    New-Item -ItemType Directory -Path $env:LOCALAPPDATA | Out-Null
    $env:QUORUM_AGENT_NODE = (Get-Command node.exe).Source
    $env:QUORUM_AGENT_BRIDGE = $quorumBridge
    $env:QUORUM_AGENT_PLATFORM = (Resolve-Path 'packages/storage-agent-desktop/target/debug/quorum-agent-platform.exe').Path
    $quorumProcess = Start-Process -FilePath 'packages/storage-agent-desktop/target/debug/quorum-storage-agent-desktop.exe' -PassThru
    if (-not $quorumProcess.WaitForInputIdle(15000)) { throw 'GUI not ready' }
    Start-Sleep -Seconds 1
    $quorumProcess.Refresh()
    if (-not $quorumProcess.CloseMainWindow()) { throw 'Cannot queue close' }
    Start-Sleep -Seconds 1
    if ($quorumProcess.HasExited) { throw 'Exited while busy' }
    Set-Content -LiteralPath (Join-Path $quorumProbe 'phase') -Value 'COPYING' -Encoding ascii
    Start-Sleep -Seconds 1
    $quorumProcess.Refresh()
    if ($quorumProcess.HasExited) { throw 'Queued close interrupted migration' }
    Read-Host '确认迁移弹窗已显示并保存截图后，按 Enter 继续；未显示则中止验收' | Out-Null
    if (-not $quorumProcess.CloseMainWindow()) { throw 'Cannot send migration close' }
    Start-Sleep -Seconds 1
    if ($quorumProcess.HasExited) { throw 'Migration close exited GUI' }
    Set-Content -LiteralPath (Join-Path $quorumProbe 'phase') -Value 'COMPLETED' -Encoding ascii
    Start-Sleep -Seconds 5
    $quorumProcess.Refresh()
    if ($quorumProcess.HasExited) { throw 'Migration completion replayed old close' }
    if (-not $quorumProcess.CloseMainWindow()) { throw 'Cannot send fresh close' }
    if (-not $quorumProcess.WaitForExit(15000) -or $quorumProcess.ExitCode -ne 0) { throw 'Fresh close failed' }
    'PASS: busy close cleared by migration; completion stays open; fresh close exits'
} finally {
    if ($quorumProcess -and -not $quorumProcess.HasExited) { $quorumProcess.Kill(); $quorumProcess.WaitForExit() }
    foreach ($quorumName in $quorumSavedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($quorumName, $quorumSavedEnvironment[$quorumName], 'Process')
    }
}
```

分别将最后的 `COMPLETED` 改为 `CANCELLED` 重跑；等待／失败状态可另将 `COPYING` 改为 `READY_TO_CONFIRM`、`FAILED`。保存执行输出和原生窗口截图。脚本在本文编写时未在 Windows 执行，运行失败须定位原因，不可直接标为通过。

## 8. 安装包与干净环境

功能验收完成后从同一提交构建发行包，运行仓库现有检查：

```powershell
. .\scripts\windows-env.ps1
pnpm release:storage-agent:windows
if ($LASTEXITCODE -ne 0) { throw 'Release build failed' }
powershell -NoProfile -File scripts/windows/smoke.ps1 -Artifacts release/windows -IncludeInstaller
if ($LASTEXITCODE -ne 0) { throw 'Installer smoke failed' }
```

安装烟测会实际操作当前用户的安装及注册项，先退出日常 Agent；优先在专用 Windows 测试账户或 Windows Sandbox 执行。Sandbox 内带入相同产物和 smoke 脚本，保留可写报告目录；使用已确认的执行策略。

- [ ] 校验 `SHA256SUMS`、`release-manifest.json`、PE 依赖及对应源码包，记录 commit／sourceDirty；正式候选应来自干净提交。
- [ ] 隔离 PATH 后，捆绑 Node／helper／GUI 可用；不依赖本机 Node、Rust 或 VC 开发工具。
- [ ] ZIP 启动、普通忙碌期间延后关闭、用户级安装、重复安装、运行中拒绝升级、快捷方式、卸载／再次安装均通过；保留 `smoke-results.json` 和安装卸载日志。
- [ ] 协议和连接文件关联实际唤起正确程序，Windows 确认框正常；卸载保留配置与会议数据，不覆盖用户已有的其他默认关联。
- [ ] 用打包后的正式程序至少复验一次真实迁移、源清理后批准与冲突恢复、窗口关闭和重新启动。debug 构建通过不代表发行包已通过。

## 9. 记录与完成条件

每项标为“通过／失败／未执行／环境阻塞”，写明步骤、预期、实际结果和证据路径。不能将旧版本记录、Linux 测试、受控桥接消息或数据库状态等同于当前 Windows 实际文件验收。

```text
提交编号／工作区状态：
Windows 版本／缩放／NTFS 目录：
服务端提交／数据库版本／HTTPS 地址：
工具版本／产物 SHA-256：
编号（如 A2、R4）：
输入文件 ID／版本／大小／SHA-256：
步骤与实际结果：
Windows 目标文件／服务器下载的大小和 SHA-256：
相关任务／迁移 ID、进程 PID：
日志／截图位置：
结论（通过／失败／未执行／环境阻塞）：
```

完成条件：自动测试无未处理失败；第 4—7 节核心迁移和关闭项目有当前提交的 Windows 证据；发行验收单独注明通过范围；所有未执行项明确保留。故障注入修改和网络阻断已恢复，不遗留测试 GUI、桥接、CLI、目录锁或临时服务器触发器。记录不得包含密码、设备凭据、配对码或任务领取令牌。
