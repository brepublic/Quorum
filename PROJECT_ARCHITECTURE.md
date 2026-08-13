# Quorum 架构与组件说明

> 本文件是本仓库的维护入口。后续涉及代码、构建、测试或运行的工作，应先阅读本文件和 `AGENTS.md`，并以实际代码为准更新本文档。

> Quorum 已完成自主托管目标设计，并已落地实施计划阶段 0–5 和阶段 6.1–6.4。`self-hosted` 运行时以 PostgreSQL 为唯一业务真相，通过同源 API 与受众过滤 SSE 提供议事功能；上传可流式暂存并提交到服务器持久卷或 S3 compatible provider。公开下载流程和文件 UI 尚未接入。

## 1. 项目定位与技术栈

Quorum 是一个用于 Model UN（模拟联合国）委员会管理的单页 Web 应用。它基于开源项目 [Muncoordinated](https://github.com/MaxwellBo/Muncoordinated-2)，当前源码仓库为 [brepublic/Quorum](https://github.com/brepublic/Quorum)。默认运行时仍由浏览器直接访问 Firebase，账号管理等少量操作使用 Firebase Cloud Functions；显式选择 `self-hosted` 时则通过常驻的同源 API/SSE 和 PostgreSQL 处理已经迁移的业务。两个运行时互斥，不双写。

| 层级 | 实现 | 责任 |
| --- | --- | --- |
| UI | React 18、Semantic UI React、flag-icons SVG、CSS | 页面、表单、响应式导航、计时器、提示、国旗与中英文界面 |
| 路由 | React Router v5 + `history` | 客户端路由及页面切换 |
| 状态/实时同步 | Firebase Realtime Database（兼容 API 为主） | 委员会及其所有业务数据的实时读取和写入 |
| 身份认证 | Firebase Authentication + Cloud Functions | 邮箱登录、管理员初始化、管理员创建/重置/删除账号及写入权限身份 |
| 文件 | Firebase Cloud Storage | 委员会附件上传、下载、删除 |
| 可观测性 | Google Analytics、Sentry | 页面访问与客户端错误/性能上报（仅非本地模拟器模式） |
| 构建/测试 | Vite、TypeScript、Vitest、Cypress、Firebase CLI | 开发服务器、生产构建、单元和端到端测试 |
| 自托管后端 | Node.js 22、PostgreSQL 16、Argon2id、Caddy、Docker Compose | migration、身份、委员会领域、实时议事、表决、审计和同源 API/SSE |

## 2. 运行时总体结构

```mermaid
flowchart LR
  Browser[浏览器]
  Entry[src/index.tsx]
  App[src/App.tsx]
  Pages[pages 与 components]
  Models[models 与 modules]
  Auth[Firebase Auth]
  RTDB[Firebase Realtime Database]
  Storage[Firebase Storage]
  Functions[Firebase Functions]
  Obs[GA / Sentry]

  Browser --> Entry --> App --> Pages --> Models
  App --> Auth
  Pages --> RTDB
  Pages --> Storage
  Pages --> Functions --> Auth
  Functions --> RTDB
  Entry --> Obs
```

`src/index.tsx` 初始化 Google Analytics、Sentry、浏览器 history 与 Semantic UI 样式，并把 `App` 挂载到 `#root`。`VITE_RUNTIME_MODE` 显式选择运行路径：未设置或为 `firebase` 时保持原行为，`src/App.tsx` 初始化 Firebase，并在显示普通路由前调用 Functions 检查管理员初始化；`VITE_USE_FIREBASE_EMULATORS=true` 时连接本机模拟器，否则连接 `muncoordinated`。`VITE_RUNTIME_MODE=self-hosted` 使用 `SelfHostedIdentity` 与 `SelfHostedWorkspace`：身份、账号管理、委员会列表、模板和议事工作区均调用同源 `/api/v1`；每个浏览器对一个委员会最多保持一条 SSE。公开委员会深层路由可匿名读取过滤后的快照。两个运行时没有双写。

`server/` 是自主托管模块化单体。它启动时通过 PostgreSQL advisory lock 执行带 SHA-256 校验和的 migration；数据库版本不兼容时 readiness 失败。阶段 2–4 migration 建立身份、委员会、规则包、模板及低并发议事。阶段 5 migration 5–12 增加实时议事、表决和版本化决议草案。migration 13 增加存储绑定、逻辑文件、不可变文件版本、blob 完整性元数据和不可变删除墓碑；migration 14 增加 durable upload；migration 15 把 provider blob 目标和已提交 file entry/version 绑定到 upload；migration 16 增加 S3 provider 配置和加密凭据列。schema compatibility 为 16。

首次启动生成高熵 bootstrap secret，只把 SHA-256 哈希写入数据库，并在专用控制台行显示一次；初始化事务锁定单行设置、创建唯一 `SYSTEM_ADMIN` 后清除哈希。密码使用固定参数 Argon2id；Session Cookie 为 `Secure`、`HttpOnly`、`SameSite=Lax`，数据库只保存 Session token 的 SHA-256；写请求同时校验允许 Origin 和双提交 CSRF token。登录、密码确认提权和改密会轮换 Session，重置密码、禁用账号和用户级撤销通过 `session_version` 与撤销时间立即使旧 Session 失效。

身份 HTTP 面包括 bootstrap、登录、退出、当前身份、提权、改密和管理员账号命令。阶段 3/4 API 提供委员会、规则包、模板和低并发切片。阶段 5 API 提供 SSE、计时器、发言名单、发言与让渡、动议、正式 ballot、意向性投票和版本化决议草案命令；写命令使用 revision，重试型创建使用 `Idempotency-Key`。工作区快照和 SSE 按 PUBLIC、member、Chair 与 Owner 过滤。系统管理员和 Committee Owner 都不自动获得 `CHAIR`。所有业务变更从 Session 推导 actor，并在同一 PostgreSQL 事务中提交状态、委员会事件和审计。

邀请码明文只在创建响应中返回一次，数据库只保存 SHA-256。兑换事务锁定邀请码，在同一事务内检查期限、撤销和剩余次数，再写 membership 与 assignment；客户端不能更换目标席位。规则运行时只接受受限 JSON AST，拒绝未知字段、未知事实、无效引用、继承循环、类型错误、除以零和复杂度超限。内置包和已发布版本不可原地修改；模拟只返回计算值与声明式计划效果，不写议事状态。

`packages/contracts/` 保存浏览器、后端和 Agent 共用的错误码、事件、审计动作、阶段 3–6 响应类型和不可变规则评估快照；`packages/rule-schema/` 保存规则包 v1 校验、有限表达式求值、模拟、有效值解析，以及 `Quorum Default` 和北京学术标准 fixture。自托管前端通过 workspace 依赖导入共享契约；Firebase 页面仍使用既有模型。阶段 0 行为基线见 [`docs/self-hosted/CURRENT_BEHAVIOR_BASELINE.md`](./docs/self-hosted/CURRENT_BEHAVIOR_BASELINE.md)。

`src/i18n.tsx` 提供无外部运行时依赖的界面国际化层。当前支持英语和简体中文；英语原文同时作为稳定词条键，简体中文词条集中维护。`LanguageProvider` 在语言变更时重新挂载界面，使类组件与函数组件统一获取新文案，并集中覆盖 Semantic UI 的搜索空结果、可新增选项等默认文案；语言切换控件嵌入主页、创建页和委员会工作区的导航菜单。用户选择保存在浏览器 `localStorage` 的 `muncoordinated-language` 项中，首次访问则根据浏览器语言选择默认值。除用户模板、国家模板和国家名称外，业务数据（委员会名称、帖子正文等）不会被翻译或写回；这些可本地化名称均在 Firebase 中保存默认语言和语言到名称的映射，并按当前界面语言解析。内置默认国家模板从静态国家列表生成，包含英语、简体中文名称、Emoji 国旗和大洲；标准 ISO 国家在界面中使用本地打包的 `flag-icons` 独立 SVG 渲染，以保证放大后的清晰度，自定义 Emoji 与上传图片仍按保存值显示。

`src/theme/` 提供纯前端外观主题系统。`ThemeProvider` 包裹整个应用，根据当前路由在 `#quorum-app` 写入稳定的页面/区域和受控外观属性，并为常见 Semantic UI 节点补充组件类型令牌；当前内置样式是不附加覆盖的默认主题。推荐的主题 API 2 是单个声明式 `.quorum-theme.json` 文件，只能设置经过白名单约束的语义颜色、排版、密度、形状、材质、动态预设、组件变体和页面内容宽度；导入器拒绝未知字段，并在安装前验证关键文字、语义按钮和焦点颜色的 WCAG 对比度。运行时由 Quorum 自己把这些设置映射为 CSS 变量和有限的 `data-theme-*` 属性，因此主题不能隐藏或重排业务控件。旧版 API 1 任意 CSS 主题继续通过 `@scope (#quorum-app)` 兼容，但在管理器中标记为旧版格式。导入、切换、删除与当前选择仅使用浏览器 `localStorage`，v2 存储会读取旧 v1 键完成迁移；导出由浏览器下载触发，不改变 Firebase、规则、路由或业务组件树。主题管理器位于作用域外作为恢复入口。完整契约见 `THEME_ADAPTER_GUIDE.md`。

简体中文排版由 `src/App.css` 中基于 `html[lang='zh-CN']` 的全局规则控制：统一中文字体回退、菜单/按钮/表头和术语列的防拆分规则，并通过 CSS 容器查询按栏宽调整表格密度；支持 `word-break: auto-phrase` 的浏览器会自动使用词组感知换行。新增页面通常无需为中文逐项添加排版补丁。

## 3. 路由与页面职责

| 路径 | 页面/组件 | 主要职责 |
| --- | --- | --- |
| `/` | `Homepage` | 产品主页与入口 |
| `/onboard`、`/committees` | `Onboard` | 登录后创建委员会 |
| `/templates` | `Templates` | 管理当前登录账号的自定义委员会模板及模板成员 |
| `/countries` | `Countries` | 管理账号级国家模板、国家多语言名称、Emoji/图片国旗和大洲 |
| `/admin` | `AccountAdmin` | 首次创建唯一管理员，以及管理员创建账号、重置密码和删除账号 |
| `/committees/:committeeID` | `Committee` | 订阅整个委员会数据、显示欢迎页及主导航 |
| `.../setup` | `Admin` | 委员会基础资料与成员设置 |
| `.../roll-call` | `RollCall` | 按代表团逐一记录出席状态、自动翻页并在点名完成后展示人数与议事门槛 |
| `.../motions` | `Motions` | 动议队列、表决及相关计时流程 |
| `.../unmod` | `Unmod` | 自由磋商计时器 |
| `.../caucuses/:caucusID` | `Caucus` | 主发言名单或有主持核心磋商、发言队列、发言记录与计时 |
| `.../resolutions/:resolutionID/:tab?` | `Resolution` | 决议文本、修正案、讨论流与投票 |
| `.../strawpolls/:strawpollID` | `Strawpoll` | 意向性投票选项与计票 |
| `.../notes` | `Notes` | 委员会笔记 |
| `.../posts` | `Files` | 链接、文本和 Storage 附件 |
| `.../stats` | `Stats` | 委员会统计 |
| `.../settings`、`.../help` | `Settings`、`Help` | 行为设置和使用帮助 |

Firebase 运行时的 `Committee` 是委员会工作区壳层，对 `/committees/:committeeID` 建立 Realtime Database `value` 订阅。自托管运行时由 `SelfHostedWorkspace` 接管相同深层路径，先读取 schema v2 快照，再以 `Last-Event-ID`/`after` 连接受众过滤 SSE。序号缺口、未知事件和 410 游标过期都会丢弃增量并重新读取完整快照；心跳不改变业务状态，Caddy 对事件流禁用缓冲。

点名页把每个代表团的最终出席/缺席结果保存到成员现有的 `present` 字段，并用 `rollCall/called/{memberID}` 与 `rollCall/currentMemberID` 保存点名进度和当前代表团，因此刷新或重新进入页面后仍可继续。撤销历史和手动翻页位置仅属于当前页面会话状态。委员会设置页只展示总人数、有表决权人数与法定人数，依赖点名结果的出席人数和各类议事门槛会在点名完成后统一展示。

`present` 也是后续议事流程的统一出席来源：缺席代表团会保留在动议、决议表决和发言名单的选择界面中，但以缺席状态灰显且不能操作；已经排入发言队列后才变为缺席的代表团会被自动跳过。决议页的动态、文本、修正案和表决子页共用全宽响应式外框及统一的页边距，以保持标签菜单、决议名称和状态控件在子页间的位置稳定。决议表决页使用可分页的代表团矩阵，逐国记录赞成、反对或弃权，并同时展示简单多数、三分之二多数和实时票数；通常在已达到门槛或剩余票数已不可能达到门槛时自动显示结果，但委员会中存在一票否决席位时，必须等待所有出席且有表决权的代表团完成表决后才显示通过、未通过或被否决的结果。公开动议投票以 `memberID` 作为票键，不再使用浏览器匿名投票者 ID，数据库规则会校验投票代表团仍为出席状态。

主发言名单在导航中独立于有主持核心磋商，但继续复用 `caucuses/gsl` 的页面、队列和发言记录数据，只显示并驱动每位代表的发言计时器。代表发言倒计时归零只会停止该计时器，不会改变主发言名单的开放状态，主发言名单也不参与任何自动结束判定。发言开始后必须先暂停才能切换至下一位；原发言人可把大于一秒的剩余时间让渡给主席、其他代表、问题或评论，受让发言、回答和评论均继承原剩余时间且不得再次让渡。开始、暂停、继续、结束和让渡决定会按服务器时间写入 `caucuses/gsl/logs`，为后续正式日志界面保留持久化记录。其他有主持核心磋商的发言计时器和磋商计时器在代表发言期间同步启停；一名代表发言结束后，发言计时器按单位发言时长重置，磋商计时器保留剩余时间并暂停。所有计时器到零后会自动停止且不会进入负数。若剩余时间不足一次完整发言，磋商自动关闭并引导主任返回动议界面。

动议提出后会一直保留在动议列表中，直至仍处于待裁决状态时被删除。主任确认“通过”或“未通过”后，动议会保存 `result` 与 `decidedAt`；会创建或更新其他议事资源的动议还会保存 `destination`，供用户从已裁决动议跳转到对应页面。旧动议没有这些可选字段时仍按待裁决状态显示。

## 4. 数据模型与数据流

Realtime Database 的主根节点是：

```text
committees/{committeeID}
  creatorUid, name, chair, topic, conference
  template, templateKey, countryTemplateKey, temporaryTemplate
  members/{memberID}
  rollCall
    called/{memberID}: true
    currentMemberID
  caucuses/{caucusID}
    logs/{logID}: message, createdAt
  resolutions/{resolutionID}
  strawpolls/{strawpollID}
  motions/{motionID}
  files/{postID}
  timer, notes, settings

templates/{creatorUid}/{templateID}
  name
  defaultLanguage
  names/{languageCode}
  countryTemplateKey
  members/{memberID}
    name, rank, present, voting, flag?/{type,value}

countryTemplates/{creatorUid}/{countryTemplateID}
  name, defaultLanguage, names/{languageCode}
  countryLanguages/{index}
  countries/{countryID}
    name, defaultLanguage, names/{languageCode}
    continent
    flag/{type,value}

system
  adminUid
  bootstrapComplete
```

`src/models/committee.ts` 定义 `CommitteeData`、默认委员会和内置模板。`src/models/template.ts` 定义账号级自定义模板及其 Firebase 增删改辅助函数；模板成员复用委员会成员的四种 `Rank`、出席、必须投票字段，并可携带从国家模板取得的自定义国旗快照。`src/models/country-template.ts` 定义内置及账号级国家模板；上传的图片国旗在浏览器端等比缩放到最大 256×160 并转为 WebP data URL，随国家记录保存到 Realtime Database，不使用 Storage。把模板成员加入委员会时会继续保存国旗快照；对已有同名成员重新应用模板也会更新其自定义国旗。其余 `src/models/*.ts` 文件定义对应子资源（成员、动议、磋商、决议、调查、帖子、计时器和设置）及创建/更新辅助函数。页面通过 Firebase 引用的 `on('value')` 接收实时快照；`src/modules/handlers.ts` 将输入控件事件映射为字段级 Database 写入。计时相关更新使用 Realtime Database transaction，以减少并发更新冲突。

每个委员会模板通过 `countryTemplateKey` 固定引用一个国家模板；多个委员会模板可以引用同一个国家模板，旧委员会模板缺少该字段时按 `builtin:default` 读取。模板编辑器允许更改这项引用，国家管理器删除自定义国家模板前会按该字段查询当前账号的委员会模板，若仍有引用则拒绝删除并列出占用模板；`database.rules.json` 为这项检查配置了索引。创建委员会时会把委员会模板及其国家模板引用一并快照到委员会；未选择现有委员会模板时，创建页必须要求选择国家模板，并以 `temporaryTemplate: true` 标记为手工设置的临时委员会模板。设置页随后按委员会保存的国家模板加载可选国家及国旗；从现有委员会模板追加成员时会同时把委员会切换到该模板及其国家模板引用。

浏览器本地还会通过 `src/hooks.ts` 的 `useLocalStorage` 保存匿名投票者 ID；意向性投票使用它识别同一浏览器。动议投票则使用所选代表团的 `memberID`，以便将票与持久化的出席状态关联。

## 5. 身份、权限与文件

- `src/components/auth.tsx` 只提供 Firebase 邮箱密码登录，不提供网页端自行注册或找回密码入口，并查询 `creatorUid` 等于当前用户 UID 的委员会以显示“我的委员会”。管理员登录后还会显示账号管理入口。
- 首次部署时，`App` 强制显示管理员创建程序。新账号登录后调用 `bootstrapAdmin`；该函数通过 `system/adminUid` 的 Realtime Database 事务确保只能有一个初始化胜者，随后为该 UID 写入 `admin: true` 与 `managed: true` 自定义声明并标记 `system/bootstrapComplete`。客户端无法写入这两个系统字段。
- `functions/src/index.ts` 使用 Firebase Admin SDK 实现账号列表、创建、密码重置和删除。每个管理函数都同时校验调用者 ID token 中的 `admin` 声明与服务端保存的 `system/adminUid`；通过后台创建的普通账号带有 `managed: true` 声明。委员会、账号级模板与国家模板的 Database Rules 也要求该声明，因此绕过网页直接调用 Firebase Auth 注册接口得到的身份无法使用主任写入功能。管理员账号不能删除自身。账号删除仅删除 Authentication 身份，不级联删除委员会、模板或附件。
- 登录后的“我的委员会”列表与委员会右上角账户弹窗共用同一账户组件；主任确认删除委员会后，客户端会先递归删除 `Storage/committees/{committeeID}` 下的附件，再删除 Realtime Database 的整个 `committees/{committeeID}` 节点。账号级 `templates` 与 `countryTemplates` 位于独立根节点，不参与委员会删除。
- `database.rules.json` 允许读取委员会；常规写入要求登录用户带有 `managed: true` 声明且是该委员会创建者。对公开队列、公开修正案、公开调查选项/投票和公开动议存在细粒度例外。公开发言排队、动议提出与动议投票会校验对应 `memberID` 的 `present` 状态，并校验公开提交的代表团名称与成员记录一致。
- `templates/{creatorUid}` 仅允许 UID 对应的受管登录用户读写，自定义模板不会向其他账号或未登录访问者公开。
- `countryTemplates/{creatorUid}` 同样仅允许 UID 对应的受管登录用户读写；内置默认国家模板随前端代码发布，不写入 Firebase。
- `storage.rules` 允许公开读取 `committees/{committeeId}/{fileName}`；上传需写入委员会创建者 UID 元数据。文件拥有者或委员会主任可更新/删除。
- `Files.tsx` 同时维护 Database 中的文件/帖子元数据和 Storage 中的二进制对象。
- 自主托管模式的 `src/pages/SelfHostedIdentity.tsx` 与 `SelfHostedWorkspace.tsx` 不复用 Firebase 身份、Database 引用或 Callable。管理员创建普通账号时由服务端生成一次性临时密码；首次登录只能读取当前身份、退出或改密。议事页面通过 `src/services/self-hosted-api.ts` 发送同源 Cookie、CSRF、revision 和幂等键，并由 `src/pages/self-hosted/ProceedingsPanel.tsx` 展示服务器时间推导的计时、名单、动议、表决、意向性投票和决议草案。管理员不能禁用唯一系统管理员；完整账号匿名化与资源转移仍属于后续阶段。
- 阶段 6.1 的 `server/src/modules/storage/service.ts` 只提供 provider 校验完成后的内部 PostgreSQL 提交边界。它从 Session 推导 actor，并在同一事务中写入文件状态、委员会事件和审计。逻辑删除立即清除当前版本指针、追加墓碑并把 blob 标记为待物理删除；数据库触发器禁止修改文件版本、墓碑或复活已删除文件。
- 阶段 6.2 的 `Stage6UploadService` 通过 `POST /api/v1/committees/:id/file-uploads` 创建上传，再由 `PUT /api/v1/file-uploads/:id/content` 直接消费 HTTP 流。`DurableStagingStore` 以服务器 UUID 生成路径，逐块执行全局与单文件上限、实际大小和 SHA-256 校验，并拒绝绝对路径、点路径、符号链接逃逸和非普通文件。完整内容只进入 `STAGED`；本阶段不调用 provider 提交，不创建 `file_entry`、`file_blob` 或 `file_version`。`CREATED`、`RECEIVING` 和 `STAGED` 即使过期也不属于普通清理范围。
- 阶段 6.3 的 `Stage6ServerVolumeService` 只接收 `STAGED` upload。`ServerVolumeStore` 从暂存文件流式复制到由 blob UUID 派生的 0600 临时文件，执行 `fsync`、无覆盖原子发布和最终重读校验；路径检查拒绝符号链接、硬链接和非普通文件。`POST /api/v1/file-uploads/:id/commit` 在 provider 验证后用一个事务提交 upload、blob、file entry/version、事件、审计和幂等响应。数据库失败会保留暂存与服务器卷副本，重试复用原 blob ID；服务器卷读取原语已实现，但尚未开放下载 HTTP。
- 阶段 6.4 增加实例级 `S3_COMPATIBLE` 配置、AES-256-GCM 凭据密文和 SigV4 HTTPS 适配器。系统管理员管理配置，Chair 只能把委员会绑定到活动配置。endpoint 在保存时拒绝危险 URL，并在每次 DNS 解析后拒绝非获准私网、回环、链路本地和元数据目标，同时把 TLS 主机名连接固定到已检查地址。S3 object key 只由管理员 prefix 和 blob UUID 派生；上传后 GET 重算大小和 SHA-256，再复用阶段 6.3 的原子发布事务。真实 S3 compatible 服务仍需按人工验收清单验证。

因此，数据库规则和 Storage 元数据是产品的关键安全边界；变更前必须同时审查前端写入路径与这两份规则文件。

## 6. 工程目录与部署

| 位置 | 内容 |
| --- | --- |
| `src/pages/` | 路由级业务页面 |
| `src/components/` | 可复用 UI、认证、计时器、通知、连接状态 |
| `src/models/` | 数据类型、默认值和 Firebase 数据操作 |
| `src/services/account-admin.ts` | 管理员 Callable Functions 的浏览器端类型与调用封装 |
| `src/theme/` | 本地主题包校验、路由/组件适配钩子、主题切换与导入导出界面 |
| `functions/` | Firebase Functions 管理端账号接口及独立 TypeScript 构建 |
| `server/` | 自托管 Node.js 后端、PostgreSQL migration、身份、委员会、规则包、实时议事、HTTP/SSE 安全边界和真实数据库集成测试 |
| `packages/contracts/` | 浏览器、后端和 Agent 共享的 API 类型、schema 与稳定注册表 |
| `packages/rule-schema/` | 规则包 v1 schema、无服务器校验器和内置 fixture |
| `deploy/` | Caddy、应用、PostgreSQL Compose，自托管镜像与隔离测试数据库 |
| `src/modules/` | 通用事件处理、成员转换、统计和埋点 |
| `src/i18n.tsx` | 英语/简体中文词条、语言偏好与全局语言切换控件 |
| `cypress/` | 端到端用例、模拟器种子和支持代码 |
| `scripts/` | Firebase Emulator 与 Cypress 编排、规则部署 |
| `database.rules.json`、`storage.rules` | Firebase 权限规则 |
| `firebase.json` | 本地模拟器端口与 Firebase Hosting 配置 |
| `netlify.toml` | Netlify 构建命令（`pnpm build`）与 `build/` 发布目录 |

生产构建输出为 `build/`。`firebase.json` 同时定义 SPA 回退重写；当前 `netlify.toml` 指定 Netlify 使用 Node 22。

## 7. 本地开发、验证与限制

先安装依赖：

```sh
pnpm install --frozen-lockfile
```

本仓库的 WSL 本地工具链位于被忽略的 `.tools/`。先执行下面命令，便可使用该目录中的 Node 22、pnpm 10 与 Java 21；它还会把错误继承的 Windows 临时目录改为 `/tmp`：

```sh
source scripts/wsl-env.sh
```

常用命令：

```sh
pnpm start                         # Vite 开发服务器（localhost:5173）
pnpm exec vitest run               # 一次性单元测试；pnpm test 是 watch 模式
pnpm build                         # TypeScript 检查并生产构建
pnpm emulators                     # Firebase Auth/RTDB/Storage/Functions 模拟器
VITE_USE_FIREBASE_EMULATORS=true pnpm start
pnpm test:e2e                      # 模拟器 + Vite + Cypress 集成测试
pnpm build:self-host               # 以 self-hosted 模式构建前端、contracts、规则 schema 和后端
pnpm test:self-host                # 阶段 0–6 契约、服务、HTTP 与自托管前端测试
pnpm self-host:test-db:up          # 启动只绑定 127.0.0.1:55432 的隔离 PostgreSQL
TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration
                                      # 创建、测试并清理独立 PostgreSQL 临时数据库；未配置时明确 skip
pnpm self-host:test-db:down        # 停止隔离测试数据库
```

上传默认单文件上限为 20 MiB，上传请求上限为 21 MiB，暂存期限为 24 小时；可分别通过 `QUORUM_MAX_FILE_BYTES`、`QUORUM_MAX_UPLOAD_REQUEST_BYTES` 和 `QUORUM_UPLOAD_TTL_SECONDS` 配置。暂存期限不授权删除尚未提交的唯一副本。

Firebase Emulator Suite 需要 Java 21 或更高版本。端到端测试只能连接本地模拟器，不能指向生产 Firebase 项目。Cypress 二进制若未预下载，可能因网络限制无法下载；此时至少运行 TypeScript 构建和 Vitest，并如实记录 E2E 未执行原因。

## 8. 维护注意事项

1. 这是 React Router v5、Firebase compat API 与少量 Firebase modular API 并存的代码库；修改 Firebase 初始化或引用类型时要兼容两种用法。
2. 生产默认会连接真实 Firebase。任何本地手工测试应显式设置 `VITE_USE_FIREBASE_EMULATORS=true`。
3. 不要把 Firebase 配置中公开的 Web 配置误判为服务端密钥；真正的访问控制由 Firebase Rules 和用户身份决定。
4. 新增委员会字段或公开协作功能时，同步更新 TypeScript 模型、默认值、前端写入路径、规则和测试。
5. 首次生产部署必须同时部署 Functions 与 Database Rules，再发布前端；否则前端无法检查或完成管理员初始化。管理员功能可用 `pnpm deploy:functions` 部署。
6. 自主托管迁移按 [`docs/self-hosted/IMPLEMENTATION_PLAN.md`](./docs/self-hosted/IMPLEMENTATION_PLAN.md) 的纵向切片推进。每个切片落地后同步更新本文件；只有全部运行依赖真正移除后，才删除 Firebase 相关架构和模拟器说明。
7. 阶段 1 Compose 中只有 Caddy 暴露 80/443；PostgreSQL 只在内部网络，数据库与文件使用命名持久卷。`deploy/compose.test.yaml` 是独立项目且只把测试 PostgreSQL 绑定到回环地址，重建脚本不得指向生产 Compose 卷。
8. `VITE_RUNTIME_MODE` 不允许混合值。普通 `pnpm build` 默认 Firebase；`pnpm build:self-host` 明确构建自主托管身份路径。同一用户动作不存在 Firebase/PostgreSQL 双写。
