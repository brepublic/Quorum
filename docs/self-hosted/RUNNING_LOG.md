# 自托管迁移 Running Log

本文件是长任务的恢复点。每次完成验证、提交或改变下一步时更新；只记录已经发生的事实。

## 当前状态

- 更新时间：2026-08-15
- 分支：`fix`
- 已确认基线：`fdd1a06 fix uiux`
- 当前阶段：自托管阶段 0–9 保持完成；开始把迁移前成熟交互与页面结构移植到自托管浏览器应用。
- 当前工作：全局工作区壳层、点名、旧版动议、独立直投和发言工作区已恢复到自托管 API。
- 下一步：保存发言切片检查点，再迁移决议草案、意向性投票和工作文件页面。

### 2026-08-14：界面与交互恢复定向

- 切换前 `master` 为 `681e481`，目标 `fix` 为 `fdd1a06`；两者 merge-base 为 `681e481`。
- 原工作区有 `deploy/`、`docs/`、`packages/`、`release/`、`server/` 五个未跟踪目录。其中包括 6 份与 `fix` 不同的自托管规格、本地 `deploy/.env`、编译输出和约 570 MiB Agent 发布产物；未覆盖或删除。
- `/home/makoto/code/Quorum-old` 保存从 `master@681e481` 导出的纯净旧版源码；`/home/makoto/code/Quorum-pre-fix-switch-20260814` 保存上述切换前残留及文件清单。
- 已切换到干净的 `fix@fdd1a06`。`pnpm install --frozen-lockfile` 从依赖树移除 Firebase SDK、Firebase CLI、Cypress 与 emulator 相关依赖。
- 首次 `pnpm test:self-host` 因刚移走未跟踪的 `packages/contracts/dist` 而无法解析 workspace 入口；先执行 `pnpm build:self-host` 后复跑即通过。该首次失败是构建顺序问题，不是仓库代码回归。
- `pnpm build:self-host`：通过；仅有既有 Vite 大分块警告。
- `pnpm test:self-host`：66 个文件通过、8 个 PostgreSQL 文件明确跳过；365 项通过、68 项跳过。
- `pnpm test:self-host:integration`：未配置 `TEST_DATABASE_ADMIN_URL`，8 个文件、68 项全部明确跳过。
- `pnpm verify:no-legacy-runtime`：通过。
- 已查看 4 张旧版参考图并读取 `master` 的导航、点名、动议和发言名单实现；恢复计划记录在 `UI_RESTORATION_PLAN.md`。

### 2026-08-14：界面恢复切片 1——工作区壳层

- 先增加结构测试，证明旧实现把所有委员会页面包在非全宽 `Container` 和统一 `Segment` 中。
- 委员会工作区现使用全宽容器，不再强制所有子页共享一张通用卡片；各页面可以恢复迁移前的信息架构和密度。
- 顶部路由导航、动态资源菜单、实时状态、账户菜单、主题/语言入口、系统管理入口和移动侧栏未改变。
- 针对性 Vitest：3 个文件、21 项测试通过；仅有既有 Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；仅有既有 Vite 大分块警告。
- `pnpm verify:no-legacy-runtime`：通过。
- `git diff --check`：通过。

### 2026-08-14：界面恢复切片 2——点名矩阵与任意席位改答

- 按用户确认恢复 18 席/页、三列状态矩阵、当前席位控制区、状态图例、分页、撤销、重置和完成摘要；Chair 可直接点击任意冻结席位，并可再次点击改答。
- 新增 `POST /api/v1/roll-calls/:id/set-response`。它与原顺序录入命令分离，继续由 Session 推导 actor，并在同一 PostgreSQL 事务中执行 Chair 权限、委员会状态、行锁、revision、entry 历史、事件和审计。
- 进行中直接录入后，服务端选择冻结顺序中最早的未回答席位；全部回答后完成点名并生成出席事件。已完成点名的更正会追加 entry 和 attendance event，不覆盖历史。
- TypeScript 类型检查通过；页面、HTTP 和 API 客户端 3 个定向测试文件共 43 项通过。
- `pnpm test:self-host`：66 个文件通过、8 个 PostgreSQL 文件明确跳过；369 项通过、69 项跳过。
- `pnpm test:self-host:integration`：未配置 `TEST_DATABASE_ADMIN_URL`，8 个文件、69 项全部明确跳过；没有将跳过记为通过。
- `pnpm build:self-host`：通过；仅有既有 Vite 大分块警告。
- `pnpm verify:no-legacy-runtime`：通过，生产源码、依赖、配置和构建输出未发现旧运行时引用。
- `git diff --check`：通过。
- 已保存仓库外回滚点 `/home/makoto/code/Quorum-checkpoints/02-roll-call/`；累计补丁 SHA-256 为 `a71796d140486356fcb229c979e34ba1e5e851f7422457aa00806193f8a70051`。

### 2026-08-14：界面恢复切片 3——旧版动议与独立直投

- 旧版动议表单、排序、卡片、删除、决定按钮与目标按钮继续沿用原布局和动画；主题、决议草案名称、修正案正文、意向性投票问题和工作文件任务在前端标为必填。
- migration 27 保存两个代表权限开关；`CHAIR_OPERATED` 只屏蔽其生效和显示，不清除已保存值。migration 28 为正式投票增加改答和撤回答案历史，正式投票新功能保持独立。
- migration 29 保存通过动议产生的站内目标，并让动议结果与计时器、磋商、决议草案、修正案或意向性投票资源在同一事务提交。点击“通过”不自动跳转，决定后显示旧版目标按钮。
- migration 30 增加独立动议直投当前值、追加式改答/撤回历史和资格设置历史。默认纳入出席的无实质性投票权席位；主席可在首票前取消。代表直投开始后冻结该选项，`CHAIR_OPERATED` 主席代办可继续调整。
- 动议直投采用严格简单多数 `floor(资格席位数 / 2) + 1`；红/黄/绿按钮同键撤回、异键改答。正式投票的开启、关闭和发布状态机未被替代。
- 内置规则以不可变 v2 新版本补齐旧版 16 种动议；新委员会默认最新版本，既有已冻结会期不被后台静默改写。
- 页面回归确认“纳入无投票权席位”默认开启；Chair 的直投席位选择默认落在首个席位，仍可切换至包括观察国在内的其他合资格席位。
- 本地隔离 PostgreSQL 16 已执行 migration 1–30 并重复运行；migration 与阶段 5 共 11 项真实数据库用例通过。另增 `CHAIR_OPERATED` 用例，确认未附议只作为建议、点击通过原子创建决议草案并返回目标路径。
- 真实数据库首次暴露两个点名路径缺少 `roll_call_status` 显式转换，导致所有并发结果都回滚；确认根因后只修复同范围 SQL。阶段 4 的 7 项真实 PostgreSQL 用例随后全部通过，包括顺序录入、乱序点选、改答和完成后更正。
- `pnpm test:self-host`：66 个文件通过、8 个 PostgreSQL 文件明确跳过；382 项通过、76 项跳过。TypeScript、`pnpm build:self-host` 与 `pnpm verify:no-legacy-runtime` 均通过；构建仅有既有 Vite 大分块警告。
- 全套真实 PostgreSQL 集成测试为 55 项通过、21 项失败。migration、身份、阶段 4 和阶段 5 文件全部通过；失败集中在既有阶段 3 邀请计数以及阶段 6–8 归档/存储枚举参数和触发器，未在本切片扩大修复范围，也未把全套测试标记为通过。
- 已保存仓库外回滚点 `/home/makoto/code/Quorum-checkpoints/04-motion-direct-vote/`；验证结束后已关闭并移除隔离 PostgreSQL 测试容器。

### 2026-08-15：界面恢复切片 4——发言名单与有主持核心磋商

- 实施前保存仓库外回滚点 `/home/makoto/code/Quorum-checkpoints/05-speaker-pre-implementation/`。migration 31 保存发言名单名称、代表排队开关、队列立场、逐项发言时长、让渡决定和互动目标；schema compatibility 更新为 31。
- 旧版双栏工作台现显示标题与状态、当前和下一位发言人、队列、立场、席位旗帜、大计时器、拖放重排、交错排序、快捷键和让渡卡片。客户端只发送命令；计时、队列和历史仍由 PostgreSQL 决定。
- 有主持核心磋商同时开始或暂停总计时器和发言计时器。关闭会暂停两者、完成当前 speech 并保留当前席位、等待队列和剩余时间；重开后可从保留状态继续。通过“结束有主持核心磋商”动议采用相同语义。
- 代表排队开关在 `CHAIR_OPERATED` 中显示为关闭且不可操作，数据库保留原值；切回 `DELEGATE_OPERATED` 后恢复。Chair 可继续代任意出席席位排队。
- GSL 让渡恢复旧版流程：让渡给代表先记录 offer，再记录接受或拒绝；提问只选择提问席位，原发言席继承剩余时间回答；评论由所选席位继承；详细问题或评论正文保持可选。继承时间不能再次让渡。
- 有主持核心磋商队列恢复旧版单击“让渡”。前端一次点击依次暂停、记录让渡并接受，后台保留每一步。删除当前发言人、关闭名单和关闭动议均追加 timer、speech、yield、queue 事件与审计。
- 修复 Stage 4 委员会创建路径未排序内置规则版本的问题；新委员会明确绑定最新已发布版本。真实 PostgreSQL 首次用例据此暴露旧 v1 误绑定，修正后“结束有主持核心磋商”动议事务通过。
- 本地隔离 PostgreSQL 16：migration 空库与重复执行通过；Stage 5 的 15 项用例全部通过，包括并发、双计时、关闭/重开、四类让渡、动议关闭保留队列、直投和正式 ballot。`pg` 的同一 client 并行 query 警告也已通过顺序读取消除。
- `pnpm test:self-host`：66 个文件通过、8 个 PostgreSQL 文件明确跳过；387 项通过、81 项跳过。TypeScript、`pnpm build:self-host`、`pnpm verify:no-legacy-runtime` 和 `git diff --check` 均通过；构建只有既有大分块警告。
- 已保存仓库外回滚点 `/home/makoto/code/Quorum-checkpoints/06-speaker-workspace-complete/`；副本与工作区状态清单 SHA-256 均为 `899dead67f599e152d339c439ab1ce789c90f8b7122ad9275e9b9154e2628bd9`。

## 已完成与验证

### 2026-08-13：恢复阶段 6.1 基线

- `git status --short --branch`：工作区干净；`self-host` 比 `origin/self-host` 多 1 个提交。
- 已阅读 `AGENTS.md`、`PROJECT_ARCHITECTURE.md` 和 `docs/self-hosted/` 的架构、数据/API、规则、存储、实施、基线、人工验收与阶段 6 交接文档。
- 阶段 6.1 针对性 Vitest：3 个文件、15 项测试通过。
- `pnpm build:self-host`：通过；Vite 仅报告既有的大分块警告。

## 当前环境限制

- 尚未提供 `TEST_DATABASE_ADMIN_URL`，真实 PostgreSQL 集成测试应明确 skip。
- Docker 持久卷、Caddy/TLS、S3 测试桶和多浏览器验证仍需按 `MANUAL_ACCEPTANCE.md` 上机执行。

### 2026-08-13：阶段 6.2 durable staging 与流式上传

- migration 14 增加 `file_uploads`、上传状态、预期/实际大小与 SHA-256、服务器暂存键、期限和失败摘要；schema compatibility 为 14。
- 同源 HTTP 增加 upload 创建和内容流路由；原始请求流逐块写入持久暂存区，不拼接完整文件。
- 服务端 UUID 决定暂存路径；内部路径拒绝绝对路径、点路径、符号链接逃逸和非普通文件。
- 成功内容只进入 `STAGED`，未调用 provider 提交，未创建 file entry、blob、version 或下载记录。
- `CREATED`、`RECEIVING` 和 `STAGED` 不进入普通过期清理；阶段 6.2 未实现清理 worker。
- 最终针对性 Vitest：9 个文件、40 项测试通过；1 个 PostgreSQL 文件的 6 项测试明确 skip。
- `pnpm test:self-host`：32 个文件、124 项测试通过；6 个 PostgreSQL 集成文件共 23 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、23 项测试因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- 当前 WSL 未检测到 `docker`、`psql` 或 `TEST_DATABASE_ADMIN_URL`；真实 PostgreSQL、持久卷、TLS、chunked 代理、进程终止恢复和内存曲线已写入 `MANUAL_ACCEPTANCE.md`。
- `git diff --check`：通过。

## 提交记录

- `4351291`：阶段 6.1 文件元数据、版本、存储绑定和墓碑。
- `da454ec`：阶段 6.2 durable staging 与流式上传。
- `1119c2a`：阶段 6.3 `SERVER_VOLUME` provider。
- `de214c1`：阶段 6.4 `S3_COMPATIBLE` provider。
- `3fe305d`：阶段 6.5 文件审核、授权下载和永久删除任务。
- `c30aafc`：阶段 6.6 provider 切换与失败回退。
- `f6e82d7`：阶段 6.7 磁盘阈值和后台清理。
- `c722f95`：阶段 6.8 自托管文件 UI 与阶段 6 收尾。
- `a7dd0fd`：阶段 7.1 Agent 配对、设备身份与单主机 fencing。
- `887ce8b`：阶段 7.2 durable Agent task、manifest 与流式内容边界。
- `ccf6f6a`：阶段 7.3 `CHAIR_AGENT` provider、本地变化和恢复编排。
- `3af6b1a`：阶段 7.4 Chair Agent 文件系统核心与恢复循环。
- `cf8002c`：阶段 7.5a Chair/Owner 主机管理界面。
- `ae6ff2f`：阶段 7.5b durable 冲突裁决、Agent 恢复与安全状态输出。

### 2026-08-13：阶段 6.3 SERVER_VOLUME provider

- migration 15 为 upload 保存服务器生成的 provider blob/key 和已提交 blob/entry/version 关联；schema compatibility 为 15。
- `POST /api/v1/file-uploads/:id/commit` 只接收完整 `STAGED` upload，并重新检查创建者、活动委员会和活动 `SERVER_VOLUME` binding。
- 暂存内容流式复制到 0600 provider 临时文件，经文件 `fsync`、无覆盖原子发布、目录同步和最终重读校验后才进入 PostgreSQL 发布事务。
- provider 最终路径只由 blob UUID 派生；符号链接、硬链接和非普通文件被拒绝。
- upload、blob、file entry/version、事件、审计和幂等响应在同一事务提交。数据库失败保留暂存和最终 provider 字节，同一 upload 重试复用原 blob 目标。
- 针对性 Vitest：6 个文件、36 项测试通过；1 个 PostgreSQL 文件的 9 项测试因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。随后增加资格撤销集成用例，集成文件现有 10 项明确 skip。
- `@quorum/contracts` 与 `@quorum/server` TypeScript build：通过。
- `pnpm test:self-host`：33 个文件、132 项测试通过；6 个 PostgreSQL 集成文件共 27 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、27 项测试因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 仍未提供真实 PostgreSQL、Docker 持久卷或 TLS 浏览器；断电、满盘、重启、挂载卷和代理证据记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-503。
- 阶段 6.3 已单独提交；提交以当前 `git log` 为准。

### 2026-08-13：阶段 6.4 S3_COMPATIBLE provider

- migration 16 增加实例级 S3 provider 配置、凭据密文字段、key version 和 binding 外键；schema compatibility 为 16。
- 凭据使用显式 master key 的 AES-256-GCM，AAD 绑定配置 ID 与 key version。错误 key、密文篡改和跨配置重放被拒绝。
- 系统管理员管理配置；Chair 只能绑定活动配置。配置响应、事件和审计不包含凭据。
- endpoint 只接受 HTTPS，配置和 DNS 解析后均执行 SSRF 检查；连接固定到已验证地址。私网目标只能由系统管理员显式允许。
- SigV4 适配器从 durable staging 流式 PUT；object key 只由管理员 prefix 与 blob UUID 派生，PUT 后 GET 重算大小和 SHA-256。
- provider 或数据库故障保留暂存；同一 upload 重试复用 blob/object key。阶段 6.4 不开放下载或运行删除任务。
- 最终针对性 Vitest：9 个文件、51 项测试通过；1 个 PostgreSQL 文件 12 项明确 skip。SigV4 与 AWS 官方 GET Object 测试向量精确匹配；contracts 与 server build 通过。
- `pnpm test:self-host`：36 个文件、152 项测试通过；6 个 PostgreSQL 集成文件共 29 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、29 项测试因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 没有真实 PostgreSQL、S3 compatible 测试桶、可控 DNS/TLS 或浏览器；相关验证与取证要求记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-504。
- 阶段 6.4 已单独提交；提交以当前 `git log` 为准。

### 2026-08-13：阶段 6.5 文件审核、发布、下载和永久删除

- migration 17 增加审核时间/发布 actor、数据库审核状态机和按 blob 唯一的 durable delete job；schema compatibility 为 17。
- 同源 HTTP 增加文件列表、详情、下载、提交审核、发布和逻辑删除。PUBLIC 只看到公开委员会的已发布文件；member、Chair 和 Owner 可读取未删除文件。
- 审核、发布和删除继续执行 Session、Origin、CSRF、revision 与幂等键；状态、事件、审计和幂等响应同事务提交，暂停委员会拒绝状态变化。
- 下载在发送响应头前预检 provider 大小与 SHA-256，强制安全附件头；HTML、XML、JavaScript、XHTML 与 SVG 返回 `application/octet-stream`，恶意文件名和 MIME 不能注入响应头。
- 逻辑删除立即不可见并为所有不可变版本创建 provider delete job。SERVER_VOLUME 与 S3 删除均幂等；失败退避重试，超过五分钟的 `IN_PROGRESS` claim 可恢复。阶段 6.7 的常驻 worker 尚未启动。
- 最终针对性 Vitest：7 个文件、47 项通过；2 个 PostgreSQL 文件、20 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm test:self-host`：37 个文件、167 项通过；6 个 PostgreSQL 集成文件、36 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；contracts、前端、rule-schema 和 server 均构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、36 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 仍没有真实 PostgreSQL、持久卷、S3 compatible 测试桶或 TLS 浏览器；角色矩阵、危险类型浏览器隔离、真实 provider 下载/删除、进程终止和 stale claim 恢复记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-505。
- 阶段 6.5 已单独提交；提交以当前 `git log` 为准。

### 2026-08-13：阶段 6.6 provider 切换与失败回退

- migration 18 增加 provider migration、逐内容 copy item、同内容跨 binding 已验证副本、manifest revision、claim token 和 S3 配置 revision 验证状态；schema compatibility 为 18。
- Owner 或 Chair 可创建、重试、确认和取消切换；同源 HTTP 保持 Session、Origin、CSRF、revision、幂等键和暂停状态边界，系统管理员不自动获得 Chair 权限。
- 目标 binding 在复制期保持 `MIGRATING`，旧 binding 继续为活动读取来源。常驻 worker 从源 provider 校验读取，经服务器生成的 durable staging key 流式复制，再从目标重读校验大小和 SHA-256。
- `file_versions.blob_id` 保持不可变；`file_blob_copies` 保存逻辑内容在目标 binding 上的物理副本。只有 manifest 未变且所有历史版本目标副本再次验证，确认事务才同时退役源 binding、激活目标 binding、更新委员会并完成 migration。
- 新版本和逻辑删除递增 manifest revision 并使进行中的 migration 以 `MANIFEST_CHANGED` 失败；retry 补齐新内容并取消已删除内容。provider/数据库故障、stale claim 和取消都保持源 binding 生效；取消和晚到目标写入进入 durable delete job。
- S3 迁移目标必须是活动且当前 revision 已验证的配置；配置更新会清除验证状态。已停用 S3 配置仍可读取和删除已有 blob。
- 阶段 6.5 基线复跑：针对性 Vitest 47 项通过、20 项 PostgreSQL 用例明确 skip；`pnpm build:self-host` 通过，仅有既有 Vite 大分块警告。
- 最终针对性 Vitest：5 个文件、34 项通过；1 个 PostgreSQL 文件、26 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm test:self-host`：38 个文件、173 项通过；6 个 PostgreSQL 集成文件、43 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；contracts、前端、rule-schema 和 server 均构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、43 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 仍没有真实 PostgreSQL、持久卷、S3 compatible 测试桶、多实例或 TLS 浏览器；双向迁移、真实 provider 故障、进程终止、stale claim 和确认前目标损坏记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-506。
- 阶段 6.6 已完成当前 WSL 可执行的验证；单独提交后直接进入 6.7。

### 2026-08-13：阶段 6.7 磁盘阈值和后台清理

- 阶段 6.6 基线复跑：针对性 Vitest 31 项通过、26 项 PostgreSQL 用例明确 skip；`pnpm build:self-host` 通过，仅有既有 Vite 大分块警告。
- migration 19 为 upload 和 provider migration staging 增加 cleanup attempts、next attempt、claim token、stale claim、失败摘要与删除时间，并新增不可修改的 `storage_cleanup_audit`；schema compatibility 为 19。
- `StorageCapacityMonitor` 对实际 `QUORUM_STORAGE_PATH` 执行 `statfs`。默认 80% warning、90% critical，可用有序整数百分比环境变量调整；状态转换写结构化日志且不记录存储路径。
- critical 或容量未知阻止新 upload 与新内容写入，并暂停 provider migration copy claim；已有幂等响应仍可重放。下载、议事命令、blob delete 和 staging cleanup 不受临界阈值阻断。
- readiness 在数据库/migration、必要目录或容量采样不可用时失败；warning/critical 仍返回 200 并包含使用率及可用字节，避免把仍可读实例从服务中摘除。Caddy 已转发只含固定聚合值的 Prometheus `/metrics`。
- 常驻 maintenance worker 优先运行阶段 6.5 blob delete job，再清理严格符合条件的 upload/migration staging。`STAGED`、活动或待重试 copy、唯一副本和退休源 provider 副本不会被期限、LRU 或压力删除。
- 清理使用 `FOR UPDATE SKIP LOCKED`、claim token、五分钟 stale 回收和指数退避。unlink/provider delete 后进程或数据库失败可通过“目标不存在”幂等收敛；成功和失败均追加维护审计。
- 最终针对性 Vitest：9 个文件、60 项通过；1 个 PostgreSQL 文件、30 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm test:self-host`：40 个文件、188 项通过；6 个 PostgreSQL 集成文件、47 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- 默认 `pnpm build` 与 `pnpm build:self-host` 均通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、47 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 没有真实 PostgreSQL、可控持久卷、S3、多实例、只读/满盘或进程终止环境；相关验证与证据要求记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-507。
- 阶段 6.7 已完成当前 WSL 可执行的验证；单独提交后直接进入 6.8。

### 2026-08-13：阶段 6.8 自托管文件 UI 与阶段收尾

- 阶段 6.7 已单独提交为 `f6e82d7`，提交前工作区差异检查通过。
- 6.7 基线复跑：30 项针对性测试通过；30 项 PostgreSQL 用例因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm build:self-host`：通过；Vite 仅报告既有的大分块警告。
- 增加 Chair/Owner 可读的 binding 状态和 `SERVER_VOLUME` 初始化 HTTP；系统管理员不因实例角色自动获得委员会 Chair 权限。初始 binding 可由 Owner 或 Chair 创建，未改变 provider 数据模型。
- 浏览器以固定 1 MiB `Blob.slice()` 增量计算 SHA-256，并用 XHR 直接发送原始 `File`、报告实际进度和支持取消；重试保留所选文件与稳定幂等键，不在内存中复制完整文件。
- 自托管工作区增加文件页：PUBLIC 只能下载已发布文件；member 可上传；文件所有者可提交审核和删除；Chair/Owner 可审核、发布、删除、配置 binding 和控制 provider migration。失败后刷新权威状态，409 不由客户端覆盖。
- 下载只使用同源 attachment URL，不把用户文件送入 DOM、iframe、object、data URL 或预览组件。永久删除使用明确且不可逆的短确认文案。
- 系统管理员的独立存储配置页可创建、更新、停用和验证 S3 配置；服务端不会回传凭据，浏览器不预填或记录密钥，轮换必须同时提供两项新凭据。
- 最终针对性验证：7 个测试文件、36 项测试通过；1 个 PostgreSQL 文件、31 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip；TypeScript、server build 和 `git diff --check` 通过。
- `pnpm test:self-host`：43 个文件、208 项通过；6 个 PostgreSQL 集成文件、48 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- 默认 `pnpm build` 与 `pnpm build:self-host` 均通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：6 个文件、48 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- Cypress 13.11.0 在可写临时缓存和沙箱外通过二进制校验；`pnpm test:e2e` 使用 Firebase emulators 与 Electron 118 完成既有 4 个 spec、22 项全通过。该套件验证 Firebase 运行时回归，不替代需要 PostgreSQL、真实 provider 和 TLS 的自托管浏览器验收。
- 当前 WSL 仍未提供真实 PostgreSQL、Docker 持久卷、S3 compatible 测试桶或 TLS 入口；角色矩阵、真实大文件流、provider 故障/迁移、危险类型下载隔离与可访问性证据记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-508。
- `git diff --check`：通过。阶段 6.8 完成后直接进入阶段 7.1。

### 2026-08-13：阶段 7.1 Agent 身份与 fencing

- 阶段 6.8 已单独提交为 `c722f95`；提交后工作区干净。
- 6.8 基线复跑：6 个测试文件、34 项通过；1 个 PostgreSQL 文件、31 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host`：通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- 7.1 只实施短期一次性配对、设备凭据、单活动主机、lease generation、撤销/转移、心跳和离线降级；durable task、manifest、目录同步和桌面发布包留给后续 7.x。
- migration 20 增加只保存哈希的 `storage_pairing_codes`、设备公钥/凭据哈希、历史 `storage_hosts`、委员会单调 generation、单当前 host 部分唯一索引和不可逆生命周期触发器；schema compatibility 为 20。
- 配对码来自 16 个随机字节，默认 10 分钟有效；设备凭据含服务器 device UUID 和 32 个随机字节。两种明文秘密只返回一次，不写数据库、事件、审计或日志。
- Owner/Chair 通过 Session、Origin、CSRF 和 revision 创建配对、查看 host、撤销或发起转移；`SYSTEM_ADMIN` 不自动获得权限。Agent 配对不接受 Session，后续只接受独立 `QuorumAgent` authorization scheme。
- `INITIAL` 要求无当前 host；`TRANSFER` 在新设备实际配对前保持旧 host 有效。成功配对、转移或撤销在委员会行锁事务中递增 generation；旧凭据和迟到 generation 返回 `STALE_STORAGE_LEASE`。
- 所有并发路径统一按委员会、配对码/host 的顺序加锁。部分唯一索引再保证一个委员会最多一个 `ACTIVE`/`DEGRADED` host；配对消费、host 状态、事件和审计同事务提交。
- heartbeat 只更新固定状态和最后在线时间。默认 45 秒超时的常驻 monitor 把 host 标为 `DEGRADED` 并发送 Chair 事件，不改变委员会状态；当前 generation 心跳恢复 `ACTIVE`。
- 最终针对性 Vitest：5 个文件、28 项通过；1 个 PostgreSQL 文件、6 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。contracts 与 server build、`git diff --check` 通过。
- `pnpm test:self-host`：46 个文件、215 项通过；7 个 PostgreSQL 集成文件、54 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- 默认 `pnpm build` 与 `pnpm build:self-host` 均通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：7 个文件、54 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- 当前 WSL 没有真实 PostgreSQL、自托管 TLS 实例或第二设备；真实并发配对、两设备转移、网络分区、代理/浏览器秘密泄漏搜索和长时间离线恢复记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-509。
- `git diff --check`：通过。阶段 7.1 完成后直接进入 7.2。

### 2026-08-13：阶段 7.2 Agent task 与 manifest

- 阶段 7.1 已单独提交为 `a7dd0fd`；提交后工作区干净。
- 7.1 基线复跑：5 个测试文件、28 项通过；1 个 PostgreSQL 文件、6 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm build:self-host`：通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- 7.2 只实施 durable task、manifest sequence、claim/complete/fail fencing 和服务器流式内容边界；桌面 Agent、目录监测、完整扫描与发布包留给后续 7.x。
- migration 21 预留 `CHAIR_AGENT` provider enum/约束，并增加按委员会严格递增的追加式 manifest、按 host/generation 固定的 durable task、claim/terminal request、内容暂存状态和不可变身份约束；schema compatibility 为 21。binding 命令和提交仍留到 7.3。
- 文件版本和墓碑由数据库触发器在原事务追加 manifest 并为当前 host 创建 `STORE_BLOB`/`DELETE_FILE`；新 host 配对时按每个文件最新 manifest 补建完整任务集。
- Agent manifest/task 支持游标分页；claim、complete 和 fail 复核 credential、委员会/host/task generation、file revision 和 claim token。相同 request 精确重放，不同 terminal outcome 冲突。
- `GET /api/v1/storage-agent/blobs/:id` 只为匹配的 `STORE_BLOB` claim 流式返回已复验 provider 内容；`POST /api/v1/storage-agent/blobs` 只为匹配的 `UPLOAD_BLOB` claim 流式写入服务器内部 durable staging 并校验大小与 SHA-256。
- 网络传输位于短数据库事务之外，完成时再次复核当前 lease；慢速 Agent 不长期持有委员会行锁，转移后的旧 host 不能提交完成状态。
- 阶段 7.2 尚未创建生产 `UPLOAD_BLOB` task，也未实施 `local-changes`、`CHAIR_AGENT` binding、本地目录扫描、冲突处理、桌面程序或 task staging cleanup。
- 最终针对性测试：4 个文件、10 项通过；1 个 PostgreSQL 文件、9 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。另有 migration/tokens 针对性测试一并通过。
- `pnpm test:self-host`：47 个文件、222 项通过；7 个 PostgreSQL 集成文件、57 项明确 skip。仅有既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host` 与 `pnpm build`：通过；Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：7 个文件、57 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 当前 WSL 未提供真实 PostgreSQL、自托管 TLS、真实 provider、第二设备或可控网络/进程终止环境；实机步骤和证据要求记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-510。

### 2026-08-13：阶段 7.3 `CHAIR_AGENT` provider 与恢复编排

- 阶段 7.2 已单独提交为 `887ce8b`；提交后工作区干净。
- 7.2 基线复跑：33 项针对性测试通过；9 项 PostgreSQL 用例因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。`pnpm build:self-host` 通过。
- migration 22 增加 host-bound `CHAIR_AGENT` binding、文件同步状态、upload 的 host commit 目标、Agent 本地变化和不可静默覆盖的冲突记录；schema compatibility 为 22。
- Owner/Chair 可把当前 generation 的已配对 host 设为初始 provider；普通 member 与仅有 `SYSTEM_ADMIN` 的账号没有隐式权限，暂停/归档和陈旧 revision 继续拒绝。
- 浏览器完整暂存提交返回 `202 PENDING_HOST_COMMIT` 并创建固定 generation 的 `STORE_BLOB` task。Agent 完成后，task、upload、blob、file entry/version、manifest、事件与审计在同一事务收敛；完成前不产生可下载文件记录。
- 受权限约束的 pending 查询让页面刷新或重新登录后仍显示“等待主席电脑保存”。普通 contributor 只见自己的 pending upload，Owner/Chair 可见委员会全部。
- `local-changes` 复核当前 lease、最新 manifest、墓碑和 file revision；本地新增/修改创建服务器路径的 `UPLOAD_BLOB` task，重命名和删除使用显式 revision。冲突先持久化，再返回 `CHAIR_DECISION_REQUIRED`。
- 主机转移取消旧 generation task，重排浏览器 pending upload 和每个文件最新 manifest；旧 host 独有的未上传内容转为 `HOST_TRANSFERRED` 冲突。既有文件保持 `OUT_OF_SYNC` 到新 host 完成相同 revision task。
- Chair 内容只在服务器仍有已验证 staging 时经授权路由下载；普通 maintenance worker 跳过 Chair provider 的物理删除 job，由当前 Agent 的 `DELETE_FILE` task 完成。
- 最终针对性验证：8 个文件、73 项通过；阶段 7 PostgreSQL 文件 13 项因缺少 URL 明确 skip。另复跑文件页 15 项通过。
- `pnpm test:self-host`：47 个文件、230 项通过；7 个 PostgreSQL 集成文件、61 项明确 skip。仅有既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host` 与 `pnpm build`：通过；contracts、前端、rule-schema 和 server 构建成功，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：7 个文件、61 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `git diff --check`：通过。
- 最终撤销/转移清理调整后，server TypeScript 与 Agent task/HTTP 10 项再次通过；阶段 7 PostgreSQL 13 项仍明确 skip，diff 检查再次通过。
- 真实 PostgreSQL migration/事务、TLS、两设备、长时离线、进程终止、容量清理竞态、桌面目录和浏览器视觉仍未执行；步骤与证据要求记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-511。

### 2026-08-13：阶段 7.4 桌面 Agent 文件系统核心与恢复循环

- 阶段 7.3 已单独提交为 `ccf6f6a`；提交后工作区干净。
- 新增独立 `packages/storage-agent`：配对命令从 0600 文件读取一次性码，生成 Ed25519 设备密钥，并把服务器地址、设备凭据、私钥和绝对根路径只写入 0600 私有配置。共享目录元数据不含秘密或绝对路径。
- Agent HTTP client 只允许 HTTPS 或显式 loopback，所有 fenced 请求使用 `QuorumAgent` header；凭据不进入 URL、日志或共享元数据。
- portable 路径校验拒绝绝对路径、驱动器/UNC、点路径、Windows 保留名、尾随点/空格、保留元数据路径、符号链接、硬链接与非普通文件；所有解析目标必须留在用户选择的根目录。
- Agent 每轮先心跳并分页拉取完整 manifest，先应用最新墓碑，再按删除、服务端下载、本地上传顺序处理 task。未知协议状态和不前进的分页 fail closed，陈旧 lease 立即停止。
- 服务端下载只写根目录内部的 0600 临时文件；大小、SHA-256、目标与原内容二次检查通过后原子发布并重读验证。短写、长写、哈希错误、断流、磁盘错误和并发本地编辑不会成为完整本地文件；重启先清理安全的普通临时残片。
- watcher 只作为快速提示，周期递归扫描是最终依据。扫描重算内容 SHA-256，优先识别同内容重命名，每轮只提交一个本地变化；pending upload 的 request/task/manifest 状态原子保存，可在服务器完成与本地保存之间的中断后重放收敛。
- 本地编辑、目标碰撞或墓碑冲突保留原内容并上报 durable conflict，不静默覆盖。普通故障指数退避；结构化日志只包含稳定错误码与 generation 等界定字段。
- Agent 定向验证：5 个测试文件、48 项通过；`@quorum/contracts` 与 `@quorum/storage-agent` TypeScript build 通过。
- `pnpm test:self-host`：52 个文件、278 项通过；7 个 PostgreSQL 文件、61 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host` 与默认 `pnpm build`：通过；self-host build 已包含 Agent 包，Vite 仅报告既有的大分块警告。
- `pnpm test:self-host:integration`：7 个文件、61 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip；`git diff --check` 通过。
- 当前 WSL 自动验证不能替代 NTFS/APFS、原生 watcher、Windows ACL、macOS 权限、真实 TLS/PostgreSQL、进程/系统中断和签名发布包；实机步骤与证据记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-512。
- 已撰写 `STAGE_7_5_HANDOFF_PROMPT.md`；7.5 只实施 Agent 管理、恢复状态和 revision-fenced 冲突裁决 UI，发布包留到 7.6。
- 阶段 7.4 已单独提交为 `3af6b1a`；提交前 staged diff 检查通过。

### 2026-08-13：阶段 7.5a Agent 主机管理 UI

- 文件存储面板仅向 Owner/Chair 显示当前主席电脑、在线/离线状态、最后在线时间、初始配对、转移和撤销操作；member 与仅有系统管理员身份的用户没有隐式控件。
- 一次性配对码只保存在当前页面内存，显示过期时间并可复制；关闭后不进入浏览器持久状态。创建、转移和撤销复用既有 Session、Origin、CSRF 与 committee revision 服务端边界。
- API client 与文件页定向验证：2 个测试文件、24 项通过；`pnpm build:self-host` 通过，Vite 仅报告既有的大分块警告。
- 本小任务没有改变数据库、Agent 协议或冲突状态；下一小任务继续实现 durable conflict 裁决。

### 2026-08-13：阶段 7.5b durable 冲突裁决与恢复

- migration 23 增加 `KEEP_SERVER`、`ACCEPT_LOCAL`、`SAVE_AS_NEW`、conflict revision、裁决 lease/file revision、关联 task 和一次性 application 记录；已裁决 conflict 及 task 身份不可修改，schema compatibility 为 23。
- Owner/Chair 可读取冲突并提交显式裁决。服务端在一个幂等事务内锁定委员会、当前 host、conflict 和 file entry，检查 conflict revision、lease generation、file revision、暂停状态和权限，再共同提交裁决、Chair 事件与审计。member 和仅有系统管理员身份的用户无隐式权限。
- 墓碑或已删除文件不能通过“采用本地版本”复活；旧 host 独有内容只能保留服务端状态。另存和名称冲突改名拒绝绝对路径、`..`、保留目录、Windows 保留名、尾随点/空格和冒号。
- 浏览器 conflict 响应只返回文件名，不暴露 Agent 相对目录；完整路径只返回持有当前 generation 的 Agent。
- Agent 轮询当前 generation 的已裁决 conflict，持久保存 resolution request ID，并对采用本地或另存精确重放。另存/改名先复验大小与 SHA-256；本地状态写入失败后可从已移动目标恢复。保留服务端的 force apply 只允许 conflict 或 tracked 路径；磁盘/网络故障保持 task 可重试，裁决后的新本地编辑形成新 conflict。
- `quorum-storage-agent status --config <path>` 只输出 lease generation、manifest sequence 与 tracked/pending 聚合计数，不输出设备身份、凭据、文件名、路径、哈希或正文。
- Agent/UI/HTTP/migration 定向验证最终结果为 12 个测试文件、119 项通过；阶段 7 PostgreSQL 文件的 15 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。contracts、Agent 和 server TypeScript build 通过。
- `pnpm test:self-host`：53 个文件、295 项通过；7 个 PostgreSQL 文件、63 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host` 与默认 `pnpm build`：通过；Vite 仅报告既有大分块警告。
- `pnpm test:self-host:integration`：7 个文件、63 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip；`git diff --check` 通过。
- 当前 WSL 没有真实 PostgreSQL、TLS 自托管实例、第二设备、NTFS/APFS 原生目录或浏览器视觉/键盘/辅助功能环境；实机步骤与证据记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-513。
- 已撰写 `STAGE_7_6_HANDOFF_PROMPT.md`；7.6 只实施桌面发布包、安装流程与签名配置入口，归档、备份和 Firebase 移除不得提前实施。
- 阶段 7.5b 已单独提交为 `ae6ff2f`；阶段 7.5 完成，继续阶段 7.6。

### 2026-08-13：阶段 7.6 Chair Agent 桌面发布包

- 固定 Agent 0.1.0 与 Node.js 22.23.2。`storage-agent-runtime-lock.json` 保存 Node 官方 Windows x86-64、macOS x86-64/arm64 和 Linux x86-64 归档 URL 边界与 SHA-256；下载先流式校验再进入忽略的本地缓存。
- 发布包只含编译后 Agent JS、最小 Node 运行时、`pair`/`start`/`status` 启动入口、Node 许可证、release metadata 和安装说明，不含源码映射、声明文件、`node_modules`、仓库路径或 Agent 私有状态。目标机不需要全局 Node、pnpm 或仓库。
- 自有 ZIP/tar.gz 归档器固定路径顺序、时间戳、所有者和权限；校验器执行 allowlist、重复路径、入口依赖闭包、Agent/Node 版本、运行时哈希、POSIX 执行位、外部 manifest、`SHA256SUMS` 与 canary secret 检查。
- 真实四平台未签名包已从 Node 官方归档生成并验证。连续两次离线构建得到相同 SHA-256：macOS arm64 `3d5e4f5e8048976deeab8c3bea578873544b4fc3ee65334af6ee791fd84ed400`、macOS x64 `5b492030d1824e38e2e8441d586d9620f1d1942fc4ea762ec167eb81d92ba1d9`、Linux x64 `ce3076d04d8cb21ff3836ca42976f50de8205b1ffab071c317a23940d5cedc72`、Windows x64 `bc49cca517ca19a9dc3c3ea25df668e616c9c7e28deb7bed7c05ff3cb934c592`。产物位于忽略的 `release/storage-agent/`，不提交二进制。
- Windows 签名入口只读取受保护证书存储的非秘密 thumbprint，使用 SHA-256 文件/时间戳摘要并立即验签；macOS 入口只读取 Developer ID identity 与 keychain profile，启用 hardened runtime、安全时间戳、严格验签和 `notarytool` 公证。脚本和文档不接收证书私钥、公证密码或 token。
- 归档内及 `AGENT_RELEASE.md` 记录版本化安装、原配置升级/回退和保守卸载。升级保留设备身份、共享目录元数据、pending upload 与 conflict recovery；卸载默认不删除私有配置或用户选择的存储目录。
- 发布/Agent 定向验证：7 个测试文件、60 项通过；其中发布脚本 4 项覆盖四平台伪运行时、逐字节重复构建、上游布局、路径逃逸、allowlist、权限、manifest 与秘密 canary。真实包验证器通过，Linux 包内运行时实际输出 `v22.23.2`。
- `pnpm test:self-host`：54 个文件、299 项通过；7 个 PostgreSQL 文件、63 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。`pnpm exec vitest run`：73 个文件、454 项通过；相同 7 个文件、63 项明确 skip。仅出现既有 React/Semantic UI 弃用警告。
- `pnpm build:self-host` 与默认 `pnpm build`：通过；Vite 仅报告既有大分块警告。`pnpm test:self-host:integration`：7 个文件、63 项明确 skip；`git diff --check` 通过。
- 当前 WSL 没有 Windows SDK/证书存储、NTFS ACL、SmartScreen、macOS `codesign`/Xcode keychain、APFS、Gatekeeper、Apple 公证服务或系统启动项环境；真实签名、公证、安装、升级、卸载、重启和原生 watcher 验收记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-514，未伪造成功。
- 阶段 7.6 已单独提交为 `458de03`；阶段 7 完成，继续阶段 8。

### 2026-08-13：阶段 8.1 委员会只读归档与一致性导出

- Owner 可在活动委员会概览执行“归档委员会”；归档后委员会资料、主席/席位、点名、议事、普通文本和文件写控件全部移除，文件仍可按既有权限下载。服务端既有 `requireEditable` 边界继续拒绝绕过界面的写请求。
- `GET /api/v1/committees/:id/export` 只允许归档委员会的 Owner。响应从 `REPEATABLE READ READ ONLY` 事务分页流式产生 JSON Lines，并设置 attachment、`nosniff` 与 `no-store`，不会先把完整导出读入内存。
- 导出使用显式列白名单，覆盖委员会成员/席位、规则快照、全部议事记录、事件、不可变审计和文件 manifest；排除邀请/匿名投票凭据哈希、Session、设备凭据、S3 密文、provider storage key、源 IP 摘要和文件正文。文件版本包含大小与 SHA-256。
- 查询或流失败会回滚并释放连接；只有完整导出才写 `complete` 记录。新增真实 PostgreSQL 集成测试会在临时数据库执行全部 section SQL，当前未配置 `TEST_DATABASE_ADMIN_URL` 时明确 skip。
- 定向 Vitest：5 个文件、37 项通过。`pnpm test:self-host`：56 个文件、307 项通过；8 个 PostgreSQL 文件、64 项明确 skip。`pnpm exec vitest run`：75 个文件、462 项通过；相同 8 个文件、64 项明确 skip。
- `pnpm build:self-host`：通过；Vite 仅报告既有大分块警告。`pnpm test:self-host:integration`：8 个文件、64 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip；`git diff --check` 通过。
- 当前 WSL 没有真实 PostgreSQL、TLS 浏览器、大数据量 fixture 或可控慢客户端/数据库断流环境；上机步骤与证据要求记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-515。

### 2026-08-14：阶段 8.2 委员会永久删除

- migration 24 增加不保留委员会名称明文的 durable deletion job、本次删除必需的 Agent task 关联、Agent 入站暂存清理 claim，以及由当前 job claim token 限定的数据库清除权限；相关循环外键改为只在删除事务末尾校验，schema compatibility 为 24。
- 只有归档委员会的 Owner 能以当前 revision、精确委员会名称、Origin、CSRF 和幂等键启动删除。请求事务把委员会冻结为 `DELETING`，撤销配对码，取消未完成上传、迁移和旧 Agent task，为文件写墓碑，并排队服务器卷、S3 和当前 Chair Agent 的物理删除。
- 委员会进入 `DELETING` 后立即离开列表、快照和 SSE 读取边界。常驻 worker 等待 blob delete job、upload/migration/Agent staging 和本次必需的 `DELETE_FILE` task 全部完成后，才在单个事务中清除委员会议事、文件、事件、审计、成员和委员会级规则数据；失败整体回滚并退避重试。
- 已修正 Chair Agent 删除完成回写，使由 `file_blob_copies` 产生的删除 job 也能完成；stale claim 可恢复，未清理的物理副本或暂存副本会阻止数据库清除。
- 定向测试覆盖角色、状态、revision、名称、请求边界、原子冻结/排队、provider 缺口、cleanup blocker、stale claim、清除失败回滚、Agent staging、API client 与工作区确认文案。`pnpm test:self-host`：57 个文件通过、8 个文件明确 skip；318 项通过、65 项明确 skip。
- `pnpm exec vitest run`：76 个文件通过、8 个文件明确 skip；473 项通过、65 项明确 skip。`pnpm build:self-host` 通过，仅有既有 Vite 大分块警告。
- `pnpm test:self-host:integration`：8 个文件、65 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip；`git diff --check` 通过。
- 当前 WSL 没有真实 PostgreSQL、TLS 自托管实例、S3 测试桶、可检查持久卷、Chair 真机和可控进程终止环境；上机步骤与证据要求记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-516，未伪造物理多 provider 删除成功。
- 阶段 8.2 已单独提交为 `450c35c`；继续阶段 8 的账号资源处置。

### 2026-08-14：阶段 8.3 账号资源转移与匿名化

- migration 25 允许匿名化账号清空邮箱，增加匿名字段一致性约束、不可恢复触发器、可延迟校验的模板所有权关联和 durable 身份命令幂等结果；schema compatibility 为 25。
- 只有系统管理员可匿名化已禁用普通账号，并须指定另一个活动账号和规范化后匹配的确认邮箱。唯一系统管理员、活动/已匿名化目标、无效接收方、错误确认及仍拥有 `DELETING` 委员会均被拒绝。
- 同一事务锁定账号和所属委员会，转移委员会、国家模板、委员会模板与规则包；每个委员会递增 revision，并追加 Chair 事件和系统管理员业务审计。历史议事、席位、事件和审计 actor ID 不改写。
- 资源转移后删除目标凭据与全部 Session，清空邮箱并把显示名替换为“匿名账号”。匿名化账号不能再执行密码重置、重复禁用或数据库身份恢复。相同幂等请求返回原结果，不同 body 返回稳定冲突。
- 账号管理页面只为已禁用普通账号提供“匿名化账号”，先选择活动接收账号，再以待处置邮箱确认；页面不添加无助于决定的说明段落。
- 定向 migration、identity service、HTTP、页面及类型构建通过。`pnpm test:self-host`：57 个文件通过、8 个文件明确 skip；322 项通过、66 项明确 skip。
- `pnpm exec vitest run`：76 个文件通过、8 个文件明确 skip；477 项通过、66 项明确 skip。`pnpm build:self-host` 通过，仅有既有 Vite 大分块警告。
- `pnpm test:self-host:integration`：8 个文件、66 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。真实 PostgreSQL、TLS 浏览器、故障注入和辅助功能步骤记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-517，未伪造实机结果。
- 阶段 8.3 已单独提交为 `ce4776e`；继续阶段 8.4 保留策略。

### 2026-08-14：阶段 8.4 数据与日志保留策略

- migration 26 增加追加式 `operations_retention_runs`、Session/身份幂等结果/已决定注册申请候选索引，schema compatibility 为 26。
- 常驻 worker 默认每小时运行，以 PostgreSQL transaction advisory lock 协调多实例。一个 sweep 原子清理撤销/到期后 30 天的 Session、到期业务幂等结果、30 天身份幂等结果、到期/撤销邀请码、终态后 7 天 Agent 配对码和决定后 90 天注册申请；失败全部回滚并只记录稳定码。
- 四个期限均由正整数环境变量配置，0 或负数使启动配置校验失败。`/metrics` 增加 retention 完成/失败次数和最后运行时间，不含用户标识或请求正文。
- 委员会事件、业务/身份审计、Agent task、provider/delete job、deletion job 和墓碑不参与普通期限清理。Compose 已有的 app、Caddy、PostgreSQL `json-file` 日志固定为 10 MiB × 3 文件；结构化字段继续脱敏。
- 定向配置、migration、worker、事务故障和 server build 测试通过。`pnpm test:self-host`：58 个文件通过、8 个文件明确 skip；326 项通过、67 项明确 skip。
- `pnpm exec vitest run`：77 个文件通过、8 个文件明确 skip；481 项通过、67 项明确 skip。`pnpm build:self-host` 通过，仅有既有 Vite 大分块警告。
- `pnpm test:self-host:integration`：8 个文件、67 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。真实 PostgreSQL、双实例、Docker 日志轮换和时间边界步骤记录在 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-518。
- 阶段 8.4 已单独提交为 `a588f88`；继续阶段 8.5 运维状态与恢复。

### 2026-08-14：阶段 8.5 管理状态与恢复工具

- 新增仅系统管理员可读的 `/api/v1/admin/operations/status` 与工作区“运行状态”页面。响应固定聚合 schema compatibility、容量状态、账号/委员会状态计数、五类队列深度和最近 retention 结果，不返回业务标识、路径、provider key、endpoint 或凭据。
- 新增 `pnpm self-host:backup -- <new-directory>`：在 0700 新目录中调用 `pg_dump` custom format，生成 0600 的数据库 dump、文件 provider manifest 和双文件 SHA-256 元数据。数据库连接 URL 不放入 `pg_dump` argv。
- `RECOVERY.md` 明确数据库与 provider 字节不是跨介质原子快照，要求停止写入、复制 provider、在隔离 PostgreSQL/provider 中校验每个对象并运行探针、登录、快照、导出和下载；不提供自动计划或破坏性 restore。
- 定向状态服务、HTTP 和页面测试 10 项通过；server build 与前端 `tsc --noEmit` 通过。
- `pnpm test:self-host`：60 个文件通过、8 个文件明确 skip；330 项通过、67 项明确 skip。`pnpm exec vitest run`：79 个文件通过、8 个文件明确 skip；485 项通过、67 项明确 skip。
- `pnpm build:self-host` 通过，仅有既有 Vite 大分块警告；`pnpm test:self-host:integration` 的 8 个文件、67 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip；`git diff --check` 通过。
- 当前 WSL 没有 `pg_dump`、真实 PostgreSQL、TLS 自托管实例、真实 provider 和浏览器恢复环境。SH-MAN-519 记录了角色矩阵、权限/进程参数、dump/manifest 篡改、隔离恢复、逐对象 SHA-256 和 durable worker 收敛的上机步骤，未伪造恢复成功。
- 阶段 8.5 已单独提交为 `0644875`；阶段 8 完成，进入阶段 9 Firebase 移除。

### 2026-08-14：阶段 9.1 单一自托管运行图与测试替代

- `App` 不再读取运行模式或初始化外部 BaaS；前端始终进入 `SelfHostedIdentity`，所有业务请求走同源 `/api/v1` 与 SSE。
- 删除旧浏览器页面、模型、Firebase Auth/Realtime Database/Storage/Functions 调用、Cloud Functions 工作区、Rules、hosting/emulator 配置和相关脚本。删除 `firebase`、`react-firebase-hooks`、`firebase-tools`、Cypress 依赖与锁文件传递依赖。
- 删除只覆盖旧运行时的 Cypress fixture/spec/plugin，GitHub Actions 改用 PostgreSQL 16 service，依次执行自托管测试、真实 PostgreSQL integration 和完整生产构建。Docker 构建不再复制 Functions manifest。
- `pnpm install --frozen-lockfile --offline` 通过并从本地依赖树移除 712 个旧包。源码、manifest、lock、部署、CI、脚本和新生产构建中没有 Firebase/Cypress 引用。
- `pnpm test:self-host`：60 个文件通过、8 个文件明确 skip；330 项通过、67 项明确 skip。全仓 Vitest：63 个文件通过、8 个文件明确 skip；359 项通过、67 项明确 skip。
- `pnpm build:self-host` 通过，前端由 1375 个模块/约 2.30 MiB JS 降至 953 个模块/约 553 KiB JS，仅保留既有大分块警告。集成入口 67 项因当前 WSL 未配置 `TEST_DATABASE_ADMIN_URL` 明确 skip；`git diff --check` 通过。
- 阶段 9.1 已单独提交为 `b5d6062`；阶段 9.2 仍需更新所有当前架构/测试/部署说明，并在 TLS 浏览器保存没有旧服务网络请求的 HAR 证据。

### 2026-08-14：阶段 9.2 当前架构、零残留门禁与迁移收尾

- `PROJECT_ARCHITECTURE.md` 已从双运行时历史重写为单一自托管当前事实，覆盖浏览器、同源边界、模块化单体、PostgreSQL、三类 provider、Chair Agent、归档删除、运维、仓库结构和验证边界。
- 根 README、服务端/规则 README、主题指南、自托管索引与实施计划均移除已失效的旧运行说明；阶段 0–9 标记为当前 WSL 可执行部分完成。历史 baseline、handoff 和 running log 继续保留迁移证据。
- 删除静态 Netlify 部署入口以及旧 Functions 工作区基线中误跟踪的 node_modules 链接；当前生产部署只以 `deploy/compose.yaml` 的 Caddy、应用和 PostgreSQL 拓扑为准。
- 新增 `pnpm verify:no-legacy-runtime`，检查禁止路径和生产源码、manifest、lock、workspace、CI、部署、server/packages 及实际 build 文本产物；GitHub Actions 在完整构建后执行同一检查。本轮检查通过。
- `pnpm install --frozen-lockfile --offline` 通过。`pnpm test:self-host`：60 个文件通过、8 个文件明确 skip；330 项通过、67 项明确 skip。全仓 Vitest：63 个文件通过、8 个文件明确 skip；359 项通过、67 项明确 skip。
- `pnpm build:self-host`、server build、Storage Agent build 和 `git diff --check` 通过，仅有既有 Vite 大分块警告。集成入口 8 个文件、67 项因当前 WSL 缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- SH-MAN-520 记录 clean checkout、镜像层/SBOM、Caddy TLS、多角色 HAR、DNS/代理、SSE、PostgreSQL 单写和深层路由的目标环境验收。当前未运行浏览器、Compose、真实 PostgreSQL 或生产网络，未把静态搜索冒充实机证据。
- 阶段 9.2 已单独提交为 `67d978e`；代码迁移完成，只保留 `MANUAL_ACCEPTANCE.md` 中明确延期的实机取证与发现问题后的修复。

### 2026-08-14：腾讯云全新 Ubuntu 部署手册

- 新增 `DEPLOYMENT_RUNBOOK.md`，以腾讯云 Ubuntu Server 26.04 LTS 空白主机为起点，覆盖安全组与 DNS、SSH 保护、Docker 官方仓库、固定 Git commit、生产环境秘密、Compose 首启、Caddy TLS、唯一管理员、真实业务/SSE、SERVER_VOLUME、容量与主机重启、备份恢复和上线审批。
- 每个阶段均给出可执行命令、通过条件和失败即停止的验收清单；S3 与 Chair Agent 只在实际启用时执行各自人工验收，不用 SERVER_VOLUME 结果替代。
- 官方资料核对确认 Docker 当前支持 Ubuntu 26.04 LTS；Caddy 公网证书要求正确 A/AAAA、可达的 TCP 80/443 和持久证书目录。手册明确 Docker 端口可能绕过 UFW，公网边界首先由腾讯云安全组限制，3000/5432 不得开放。
- 已识别生产恢复关卡：当前 `self-host:backup` 依赖 Node/pnpm 与 `pg_dump`，最小 Docker 主机和 app runtime 不保证具备该工具链。上线前须建立受控运维环境或经评审的专用备份镜像/profile，并完成异地复制和隔离恢复；在此之前不能宣称生产可恢复。
- `deploy/README.md` 已链接完整手册。文档存在性、章节结构与 `git diff --check` 已验证；本次仅改文档，未重跑应用测试或构建。
- 下一步：在目标腾讯云主机依次执行阶段 0–12，将结果回填 `MANUAL_ACCEPTANCE.md`；若要消除备份工具链缺口，应单独实施并测试 Docker 化备份入口。

### 2026-08-15：旧版 UI/UX 自托管恢复节点 18

- 以 `/home/makoto/code/Quorum-old` 的 `master@681e481` 为视觉和交互基线，生产路径继续只有同源 API/SSE、Node 服务和 PostgreSQL；未恢复 Firebase、客户端写库或双写。
- 已恢复旧版导航、委员会创建、会场设置、18 席分页点名、动议、动议直投、自由磋商、主发言名单、有主持核心磋商、决议草案、修正案、意向性投票、笔记、资料、统计和帮助布局；保留正式 ballot、规则包、文件审核/provider、Chair Agent、归档删除和运维能力。
- 每次会期启动事务自动创建唯一主发言名单和发言计时器；有主持核心磋商仍由必填主题表单或通过的动议创建。移动端侧栏动画恢复为旧版 `uncover`。
- 笔记保留多笔记选择器，停止输入约 600 ms 后使用 revision 命令自动保存；两项旧版布局设置由 PostgreSQL 持久化并随工作区快照下发。migration 38 增加布局列和每会期唯一 GENERAL 发言名单约束，schema compatibility 为 38。
- 全仓有限 Vitest：69 个文件、442 项通过；8 个 PostgreSQL 文件、84 项因没有可用 `TEST_DATABASE_ADMIN_URL` 明确 skip。导航、笔记自动保存及切换前落盘、TypeScript 和 diff 检查亦通过。
- `pnpm build:self-host`、`pnpm verify:no-legacy-runtime` 与 `git diff --check` 通过；Vite 仅报告既有大分块警告。
- 当前 WSL 的 `docker` 命令不可用，且 5432/55432/80/443 无监听；migration 38、当前 Stage 4/5 PostgreSQL 用例、Compose、TLS、真实浏览器视觉/拖放/动画仍未验收，不能把 skip 或 jsdom 页面测试记为实机通过。
- 完整回滚副本：`/home/makoto/code/Quorum-checkpoints/18-main-list-notes-layout`。未经用户授权未提交、推送、部署或删除 Docker volume。

### 2026-08-15：旧版 UI/UX 自托管恢复节点 20

- 移动端委员会壳层恢复迁移前的 `Sidebar.Pushable`、`Sidebar.Pusher`、`uncover` 动画和点击遮罩关闭交互；工作区内容只挂载一次，桌面端继续使用紧凑横向导航。
- migration 38 保留“一场会议只能有一个主发言名单”的数据库唯一索引。按用户确认，不为不存在的生产历史重复名单增加转换逻辑；为升级时开放且尚无主发言名单的会议自动补建名单和发言计时器，优先读取规则包默认时间并以 60 秒兜底，同时追加公开事件和 `migration.main_speaker_list_backfilled` 系统审计。
- 两项旧版布局设置增加页面级证据：队列上下位置按快照设置切换，发言/磋商计时器可分列，设置页以委员会 revision 一次提交完整设置。修正磋商计时器大按钮和 Alt+C 误调用发言命令的问题，现由磋商计时器自身的权威 timer 命令控制。
- 定向测试：migration、导航和工作区路由共 78 项通过；全仓有限 Vitest 为 69 个文件、444 项通过，8 个 PostgreSQL 文件、84 项因缺少 `TEST_DATABASE_ADMIN_URL` 明确 skip。
- `pnpm build:self-host`、`pnpm verify:no-legacy-runtime` 与 `git diff --check` 通过；Vite 仅报告既有大分块警告。真实 migration 38、PostgreSQL 集成、Compose/TLS 和浏览器动画仍需 Docker 引擎可用后取证。
- migration 38 另有真实 PostgreSQL 升级路径测试：先应用 1–37，建立开放会期，再应用 38，并核对 75 秒规则时长、计时器、公开事件、系统审计及唯一索引；当前因无 `TEST_DATABASE_ADMIN_URL` 明确 skip，server TypeScript 构建与 SQL 静态契约测试通过。

### 2026-08-15：旧版 UI/UX 自托管恢复节点 22

- Docker Desktop Linux Engine 与 Debian WSL integration 已可用；只启动独立的 `quorum-test-db-postgres-test-1` PostgreSQL 16 测试服务，未启动、重建或清除既有 `quorum-app-1`、`quorum-caddy-1`、`quorum-postgres-1` 及其卷。
- migration 38 的真实 37→38 升级测试通过：开放会期补建唯一主发言名单、规则包 75 秒发言计时器、公开事件和系统迁移审计。migration 39 修正文件进入审核流程后无法逻辑删除的触发器边界；仍禁止删除记录重新获得正文或从删除状态恢复，schema compatibility 为 39。
- 修正真实 PostgreSQL 暴露的 enum/UUID 参数类型推断、归档 fixture、测试身份唯一性、provider 删除成功但完成事务回滚后的重试，以及 Chair Agent 文件落库期间三个连续事件共用陈旧序号的问题。所有修复保持原事务、事件、审计和幂等边界，没有增加旁路或客户端写库。
- `node server/scripts/test-db.mjs test`：8 个文件、85 项真实 PostgreSQL 集成测试全部通过；空库应用 39 个 migration 并重复执行亦通过。测试使用临时数据库并在结束后清理。
- `pnpm exec vitest run`：69 个文件、445 项通过；8 个 PostgreSQL 文件、85 项在未注入数据库 URL 的普通测试入口中按设计明确 skip，同一 85 项已由上述真实测试库入口全部通过。
- `pnpm build:self-host`、`pnpm verify:no-legacy-runtime` 与 `git diff --check` 通过；生产源码、依赖、配置和构建产物未发现 Firebase 或旧运行时引用。仅有既有 Vite 大分块和第三方 React defaultProps 弃用警告。
- Compose/Caddy TLS、真实浏览器视觉、拖放、移动侧栏动画及 HAR 网络验收仍未执行；不能以 jsdom 和数据库集成测试替代。完整检查点将在本节点验证后保存。

### 2026-08-15：旧版 UI/UX 自托管恢复节点 23

- 首次以既有持久卷启动当前镜像时，migration 校验和门禁拒绝 app：数据库已应用的 migration 30 哈希为 `1800f199...7f12`，工作树从节点 08 起把同一 migration 的 `direct_vote_include_non_voting` 默认值由 `true` 改成了 `false`。没有改写数据库 migration 记录或清除卷。
- 从节点 06 的原始副本恢复不可变 migration 30，文件哈希重新与数据库一致；原值 `true` 同时符合“观察国默认参加程序性动议投票”的产品决定，因此不需要追加纠正 migration 或转换数据。真实 PostgreSQL migration 与 Stage 5 定向测试 20 项全部通过。
- `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build` 使用原卷成功：PostgreSQL 与 app 健康，Caddy 启动；服务端记录 migration version 39。数据库 `schema_migrations` 为 39 条、最大版本 39，runtime schema compatibility 为 39。
- 经 Caddy `https://localhost/health/live` 与 `/health/ready` 均返回 HTTP/2 200；readiness 报告 database migrationVersion 39、storage normal。命令行使用跳过证书校验仅确认 HTTPS 连通性，不作为 Windows Chrome 信任、本地登录 Cookie 或真实页面验收。
- 浏览器控制通道在建立连接时因桌面运行环境的工作区 URI 元数据错误而失败，未打开或操作页面。旧版视觉、拖放、移动侧栏动画、全流程点击与 HAR 零旧服务请求仍待真实浏览器验收。
- 完整回滚副本：`/home/makoto/code/Quorum-checkpoints/22-postgres-integration-green`（Compose 启动前）及待保存的节点 23。未提交、推送、删除卷或改写既有 migration 记录。

### 2026-08-15：Windows 浏览器验收交接

- 当前 WSL 无法正常连接浏览器技能或 Computer Use；真实浏览器验收转移到 Windows 环境，不把命令行 HTTPS、jsdom 或静态测试替代为浏览器证据。
- 新增 `WINDOWS_UI_ACCEPTANCE_HANDOFF.md`，记录当前 Compose/schema 39/自动化证据、旧版参照与节点 22–23、Windows 接手命令、测试角色与数据、桌面和窄屏矩阵、逐页旧版交互、动画、正式 ballot 与新增功能回归、HAR/SSE/PostgreSQL 证据、停止决策条件和完整完成标准。
- 交接清单固化已确认产品语义：任意席位点名和改答、动议直投历史与观察国默认纳入、简单多数超过 50%、通过后先执行再显示目标按钮、唯一主发言名单、文本/文件二选一和审核发布、修正案删除边界、匿名提交后锁定、旧版移动 `uncover` 动画及两个运作模式开关的临时遮蔽/恢复。
- 文档明确禁止修改已应用 migration、删除 Compose 卷、恢复 Firebase、合并旧直投与正式 ballot，或在旧版交互与新后端冲突时自行决定产品取舍。
