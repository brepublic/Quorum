# Windows 浏览器验收交接

## 目标

在 Windows Chrome 中验收：当前 `fix` 工作树是否用旧版的页面布局、操作顺序、反馈和动画驱动新的自主托管后端，同时保留新增功能，且不产生 Firebase 请求或客户端直写数据。

本轮验收以真实浏览器行为为准。Vitest、jsdom、TypeScript、构建成功和静态搜索不能代替视觉、动画、拖放、Cookie、SSE 和网络验收。

## 不可改变的边界

- 视觉和交互基线：`/home/makoto/code/Quorum-old`，`master@681e48130fbf3af835729c33eeaebf8614c2119e`。
- 当前实现：`/home/makoto/code/Quorum` 的 `fix` 分支及未提交工作树。
- 生产架构必须保持浏览器 → 同源 API/SSE → Node 服务 → PostgreSQL。禁止恢复 Firebase、旧 SDK、客户端写库、双写或第二运行模式。
- 保留正式 ballot、规则包、文件审核和 provider、Chair Agent、归档删除、运维状态等自主托管新功能。
- 不得重新设计旧版 UI/UX，不得替换旧版动画。发现旧版设计与新后端冲突或需要产品取舍时，停止并询问用户。
- 议事规则只提供默认值、建议和偏离提示。主席可覆盖学术规则；身份、权限、审计、事务、票唯一性和引用完整性仍由系统强制执行。

## 当前状态

截至 2026-08-15：

- Compose 使用既有卷运行；`quorum-postgres-1` 和 `quorum-app-1` 为 healthy，`quorum-caddy-1` 正常提供 80/443。
- 数据库已应用 migration 1–39，schema compatibility 为 39。
- `https://localhost/health/live` 和 `/health/ready` 经 Caddy 返回 HTTP/2 200。
- 真实 PostgreSQL 集成测试 85/85 通过。
- 全仓有限测试 445 项通过；普通入口明确跳过的 85 项数据库测试已由真实 PostgreSQL 入口覆盖。
- `pnpm build:self-host`、`pnpm verify:no-legacy-runtime` 和 `git diff --check` 通过。
- migration 30 已恢复为数据库实际应用的不可变版本，SHA-256 为 `1800f199eebe0fb094ebc1afe9cc1e61524ada9416b4cc5c57dcc09d31ff7f12`。不要再次修改该文件。
- Windows 浏览器视觉、动画、拖放、完整交互及 HAR 尚未验收。
- WSL 中的浏览器技能和 Computer Use 不能正常连接，因此切换到 Windows 环境继续。

当前工作树没有提交。不得用 `git reset --hard`、`git checkout -- .`、`git clean` 或 `docker compose down -v`。

## 恢复点

- 旧版只读参照：`/home/makoto/code/Quorum-old`
- 切换前旧代码存档：`/home/makoto/code/Quorum-pre-fix-switch-20260814`
- PostgreSQL 全绿、Compose 启动前：`/home/makoto/code/Quorum-checkpoints/22-postgres-integration-green`
- schema 39、Compose 健康：`/home/makoto/code/Quorum-checkpoints/23-compose-schema39-healthy`

回退时只回退已确认有问题的当前切片。先保存故障截图、HAR、日志和 diff，再说明原因。不要覆盖整个工作树，也不要改写 migration 历史或数据库中的校验和。

## Windows 接手步骤

1. 从 Windows Codex 打开 `\\wsl.localhost\Debian\home\makoto\code\Quorum`。
2. 阅读根目录的 `AGENTS.md` 和 `PROJECT_ARCHITECTURE.md`。
3. 在 WSL shell 中执行项目命令前运行：

   ```bash
   cd /home/makoto/code/Quorum
   source scripts/wsl-env.sh
   ```

4. 只读确认状态：

   ```bash
   git branch --show-current
   git status --short
   docker compose --env-file deploy/.env -f deploy/compose.yaml ps
   curl -kfsS https://localhost/health/ready
   ```

5. 若服务已健康，不要重建。若服务已停止，执行：

   ```bash
   docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
   ```

6. 只有代码变化需要新镜像时才执行：

   ```bash
   docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
   ```

7. 在 Windows Chrome 打开 `https://localhost`。确认 Windows 信任 Caddy 本地 CA；地址栏必须显示可信 HTTPS。`curl -k` 只证明连通性，不能证明浏览器信任、安全 Cookie 或登录有效。
8. 请求 `GET /api/v1/bootstrap/status`。若已初始化，使用现有测试账号。若未初始化，只能使用 app 首次启动时显示的一次性 bootstrap secret；不得把 secret 写入文档、聊天、截图、HAR 或 shell history。初始化完成后该 secret 无法恢复。

出现 migration checksum mismatch、readiness 非 200、数据库卷异常、登录 Cookie 不工作或现有数据意外消失时，停止 UI 验收，保存证据并先修复环境。

## 建议测试数据

在没有生产数据的当前实例中准备：

- 1 个 SYSTEM_ADMIN；
- 1 个委员会 Owner；
- 1 个独立 Chair；
- 至少 20 个席位，以覆盖 18 席分页；
- 至少 1 个普通有投票权席位、1 个必须投票席位、1 个无实质性投票权的观察国席位；
- 1 个绑定代表账号；
- 1 场开放会议；
- 1 个空正文决议草案；
- 1 个文本决议草案和 1 个文件决议草案；
- 1 个未表决修正案和 1 个已表决修正案；
- 匿名、席位记名和人工计票三种意向性投票；
- 1 个待审核文件和 1 个已发布文件。

不要为方便测试绕过 UI 直接改生产 Compose 数据库。确需构造边界数据时，优先使用公开 API 或独立临时数据库。

## 浏览器矩阵与取证

至少检查：

- 桌面：1440 × 900，Chrome，100% 缩放；
- 窄屏：390 × 844 或 Chrome 等效设备模拟；
- 简体中文；英文只做关键路由和布局溢出抽查；
- 默认主题；若项目保留第二主题，再抽查一次不隐藏或重排业务控件。

每个主要页面保存桌面截图。移动导航、拖放、计时器和动画保存短视频或连续截图。导出一份脱敏 HAR。截图和 HAR 不得包含密码、bootstrap secret、Session、CSRF、邀请码、设备凭据、S3 密钥或文件正文。

旧版参考图：

- `/mnt/c/Users/colin/.codex/attachments/174854f8-332a-4705-b35a-9c73cabdf5db/image-1.png`
- `/mnt/c/Users/colin/.codex/attachments/174854f8-332a-4705-b35a-9c73cabdf5db/image-2.png`
- `/mnt/c/Users/colin/.codex/attachments/174854f8-332a-4705-b35a-9c73cabdf5db/image-3.png`
- `/mnt/c/Users/colin/.codex/attachments/174854f8-332a-4705-b35a-9c73cabdf5db/image-4.png`

## 逐页验收

### 1. 身份、首页和导航

- 登录、退出和刷新后 Session 正常；强制改密流程仍可用。
- 桌面委员会页面使用旧版紧凑单层顶部导航。委员会名承担返回入口；动态议事资源使用下拉菜单。
- 账号、主题、语言、模板、运维等新入口保留在账号或管理区域，不挤入旧会议主导航。
- 深层路由刷新后仍显示当前页面，不返回空白页或 404。
- 浏览器前进、后退不会产生重复资源或重复命令。

### 2. 移动侧栏与动画

- 窄屏显示旧版 `Sidebar.Pushable` / `Sidebar.Pusher` 结构。
- 打开侧栏使用旧版 `uncover` 动画；动画方向、遮罩和内容位移与旧版一致。
- 点击内容遮罩关闭侧栏。
- 切换路由后侧栏关闭，页面内容只挂载一次，不闪烁、不重复请求、不丢失计时器状态。
- 不接受用淡入、抽屉缩放、全屏覆盖或新手势替换旧动画。

### 3. 委员会创建与会场设置

- 创建页保持旧版登录卡片/创建表单双栏任务布局和稳定字段顺序。
- 自主托管新增的公开/私有、内置/账号模板、国家模板继续可用。
- 会场设置以旧版委员会资料、席位/代表表为主任务；Chair 授权、邀请码、规则和运作模式按现有分区保留。
- General Speaker's List 的中文统一为“主发言名单”。
- 一场会议只能有一个主发言名单；开始会议后系统自动创建该名单和发言计时器。

### 4. 运作模式和代表开关

- `DELEGATE_OPERATED` 下，“代表可提出动议”和“代表可对动议投票”按保存值生效。
- 切换到 `CHAIR_OPERATED` 时，界面和权限临时禁用这两个开关并显示为关闭。
- 切回 `DELEGATE_OPERATED` 后恢复原保存值。
- 主席在两种模式下都可代任意席位操作。
- 违反议事规则最多提示；主席仍可继续，不得被前端或后端学术规则强行拦截。

### 5. 点名

- 每页 18 席，保持旧版三列状态矩阵、当前点名控制区和分页。
- 主席可直接点击任意席位作答，不要求按顺序。
- 已答席位可直接改答或撤回，页面立即显示当前结果。
- 后台保留每次点选、改答和撤回历史。
- 重置和完成流程保持旧版布局；完成后显示门槛摘要。

### 6. 动议、附议和动议直投

- 保持旧版聚焦式动议表单、代表团搜索、队列和裁决反馈。
- 动议必要信息在前端必填，包括有主持核心磋商主题、决议草案名称、修正案正文、意向性投票问题和工作文件任务。
- 动议直投完全独立于正式 ballot。席位可直接点选、改答、撤回，后台保存全部历史。
- 默认纳入观察国等无实质性投票权席位，因为程序性动议允许其参与。
- 开始投票前，主席可决定是否纳入非投票席位；开始后锁定。主席代办模式可按现有规则调整。
- 简单多数必须超过 50%；恰好 50% 不通过。
- 未附议动议不能通过，但主席可驳回。
- 页面没有“清空动议面板历史”按钮。

### 7. 动议通过与目标跳转

- 点击“通过”先执行动议效果并记录通过结果。
- 页面随后显示目标按钮，例如“有主持核心磋商”或“决议草案”。
- 只有点击目标按钮后才跳转，不得在点击“通过”时直接跳页。
- 有主持核心磋商、计时器和文档状态必须由后端命令创建或更新，不能只做前端假状态。
- 新决议草案出现后，动议选项包含“有主持核心磋商 - 决议草案 X”，并自动填入主题。该动议通过后创建关联磋商；页面没有单独“创建关联磋商”按钮。

### 8. 自由磋商、主发言名单和有主持核心磋商

- 自由磋商保持旧版单一大计时器。
- 主发言名单和有主持核心磋商保持旧版标题、当前/下一位、队列、双计时器及让渡卡片布局。
- 队列支持旧版拖放和直接操作；拖放后刷新仍保持后端顺序。
- 计时器以服务端为准。刷新、切换页面和另一个浏览器打开后剩余时间一致。
- 旧版一键让渡和快捷键继续工作；Alt+C 必须控制磋商计时器，不能误调用发言计时器。
- “队列在上/下”和“计时器分列”设置保存到后端，刷新后保留。

### 9. 决议草案

- 点击加号立即创建系统顺序命名的空草案，例如“决议草案 1”；不先显示新建表单。
- 初始正文可为空，初始状态不是“已展示”。代表必须提出并通过展示动议。
- 完全移除旧版“动态”标签和功能。
- 保留正文、修正案和表决区域，以及旧版席位表决矩阵。
- 文本或文件二选一。文件必须经过现有审核流程并发布；未发布时只提示主席，暂不执行展示动议。
- 保留正式 ballot 入口，不得用旧版矩阵替代正式投票。

### 10. 修正案

- 加号立即创建旧版卡片，不出现额外创建向导。
- 修正案支持文本或文件；文件走与决议草案相同的上传、审核、发布和展示流程。
- 不增加单独“介绍修正案”动议项目；代表仍按文件可用 → 主席宣布 → 代表动议展示的流程操作。
- 未投票表决的修正案可通过垃圾桶删除，后台追加删除记录。
- 表决后的修正案不能删除。
- 正式 ballot 保留在修正案表决区域。

### 11. 意向性投票

- 点击加号立即创建系统顺序命名的投票。
- 匿名投票：选完所有选项后点击一次“投票”提交；提交后不能改答或撤回，也不能建立投票人与选项关联。
- 席位记名投票：保持旧版直接点选，可改答、撤回，后台保存历史。
- 人工计票：保持旧版输入票数。
- 三种模式保持旧版页面布局、阶段切换和结果进度条。
- 意向性投票不能转换成正式 ballot 结果。

### 12. 笔记、资料、统计、设置和帮助

- 笔记保留多笔记选择器；停止输入约 600 ms 后自动保存。切换笔记前先保存当前内容，刷新后不丢失。
- 资料页保留文本资料和文件审核/发布流程；存储管理只对有权限的账号显示。
- 统计只展示快照可证明的数据，不推测历史。
- 设置页分开主席会议操作与 Owner 生命周期操作。
- 帮助页保留旧版快捷键和当前实际可用功能；删除无助于决策的说明文案。

### 13. 新功能回归

至少确认以下功能仍可达并可用：

- 正式 ballot；
- 规则包和主席覆盖；
- 文件上传、审核、发布、下载和逻辑删除；
- SERVER_VOLUME / S3 / Chair Agent 管理入口的权限边界；
- 委员会暂停、归档、导出和永久删除确认；
- 系统管理员账号管理、模板和运行状态。

系统管理员身份本身不得获得 Chair 控件；Owner 身份本身也不得获得 Chair 学术权限。

## 网络和后端证据

在 DevTools Network 中从登录前开始录制，完成至少一次点名、动议直投、计时器、决议草案、文件和 SSE 重连操作。

通过条件：

- 页面业务请求只发送到当前 `https://localhost` Origin 的 `/api/v1/*`、委员会 SSE、`/health/*` 和明确的聚合指标端点。
- 不出现 Firebase、Google APIs、Firestore、Realtime Database、Functions、Storage、emulator、Netlify 或第二业务后端请求。
- 浏览器不直连 PostgreSQL、S3 或 Chair Agent。
- 写请求使用 Session、CSRF、Origin 和幂等边界；客户端请求体不提交伪造 actor user ID。
- 一项操作只产生一组后端状态、事件和审计结果。刷新或 SSE 重连不重复执行命令。
- 断开网络再恢复后，SSE 从游标继续；游标过期、事件缺口或未知事件触发完整快照，不显示长期假状态。
- 陈旧 revision 返回 409，页面刷新权威状态并要求用户重试，不静默覆盖。

可结合以下只读证据：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --no-color --since=10m app
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T postgres sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT max(version),count(*) FROM quorum_meta.schema_migrations"'
```

不要把数据库完整行、请求正文或认证头保存到验收附件。

## 失败处理和决策边界

发现以下情况立即停止当前切片：

- 需要改变旧版交互顺序、动画、页面层级或主要控件；
- 旧版设计与自主托管事务、权限、审计或文件生命周期冲突；
- 需要在正式 ballot 与旧版直投之间合并或替代；
- 需要放宽服务端权限、票唯一性、文件审核或 migration 校验和；
- 数据库或卷出现意外变化；
- 修复需要删除或重建生产 Compose 卷。

向用户报告：当前行为、旧版行为、后端限制、可选方案、各方案影响。用户决定前不要猜测产品答案。

普通视觉错位、文案错误、路由错误或已明确语义的实现缺陷可直接修复。每次只修一个可验证切片，修复前保存截图和相关日志，修复后重跑定向测试及浏览器步骤。

## 修复后的最低自动化门禁

```bash
cd /home/makoto/code/Quorum
source scripts/wsl-env.sh
pnpm exec vitest run
node server/scripts/test-db.mjs test
pnpm build:self-host
pnpm verify:no-legacy-runtime
git diff --check
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
curl -kfsS https://localhost/health/ready
```

记录普通测试中的数据库 skip，并单独记录真实 PostgreSQL 结果。不要把 skip 写成通过。不要在未授权时提交、推送或创建 PR。

## 完成标准

只有以下证据全部成立，才能宣告旧版 UI/UX 自主托管恢复完成：

1. 上述逐页桌面和窄屏验收全部通过；
2. 旧版交互顺序、动画和主要布局有截图或视频对照；
3. 真实浏览器完成关键写流程，刷新后由 PostgreSQL 状态恢复；
4. HAR 和日志证明只有自主托管同源 API/SSE，没有 Firebase 或第二运行时；
5. 新功能和角色权限没有回归；
6. 全部自动化门禁通过；
7. `RUNNING_LOG.md` 写明执行环境、证据、失败和延期项；
8. 保存新的完整检查点。

若任何一项缺少证据，继续保留目标为进行中。
