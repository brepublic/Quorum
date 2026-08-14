# Quorum 自托管架构

本目录保存 Quorum 自主托管规格、实施历史、恢复和人工验收。阶段 0–9 已落地；浏览器、后端、数据库、文件 provider、Chair Agent、归档删除和运维工具均使用单一自主托管路径。当前事实以根目录的 [`PROJECT_ARCHITECTURE.md`](../../PROJECT_ARCHITECTURE.md) 为准。

## 当前阶段 9 边界

- PostgreSQL migration 已建立身份、凭据、Session、系统设置、未来注册申请和身份审计表。
- bootstrap secret 只保存哈希，并由 PostgreSQL 事务保证并发初始化只有一个成功；公开状态 API 不返回 secret。
- 密码使用 Argon2id；Session token 只保存哈希；Cookie、CSRF、Origin、限流、锁定和 Session 轮换在服务端执行。
- 自主托管前端已接入首次管理员、登录、强制修改临时密码、退出和账号管理。
- `App` 始终显示自主托管身份、账号管理、委员会、模板和议事工作区；没有运行模式开关或双写路径。
- PostgreSQL 已建立委员会、membership、Chair capability、席位、席位历史、邀请码、规则包版本、规则绑定、主席覆盖、委员会事件和业务审计。
- 同源 API 已提供阶段 3 委员会、席位、邀请码、快照和规则包命令。所有写入继续执行 Session、CSRF 和 Origin 校验。
- Committee Owner、Chair、membership、seat assignment 和 `SYSTEM_ADMIN` 分别授权。系统管理员和 Committee Owner 都不会隐式获得 Chair 能力。
- 邀请码只保存哈希；规则模拟不写议事状态；内置包和已发布版本不可原地修改。
- schema compatibility 26 覆盖阶段 4–5 业务表、完整文件/Agent 能力、委员会永久删除、账号匿名化和追加式 retention run 证据。
- 自托管 React 页面只调用同源 API；一浏览器一委员会一条 SSE，游标过期、序号缺口或未知事件回退完整快照。
- 服务器时间是计时真相；PostgreSQL 唯一约束和行锁保护队列顺序、当前发言人及一席一票。
- 正式 ballot 冻结资格、门槛、must-vote、否决席位和规则版本；票更正追加历史，匿名意向性投票不保存投票人与选项关联。
- 决议草案和修正案使用不可变版本；进入表决的版本由数据库约束冻结。
- PostgreSQL 是文件状态、版本、大小、SHA-256、blob 绑定和墓碑的唯一业务真相。文件版本与墓碑不可修改；删除后不能恢复当前版本或追加新版本。
- 上传元数据从同源 Session 推导 actor；创建和内容路由继续执行 Origin、CSRF、幂等键和请求大小边界，委员会暂停时拒绝创建或完成上传。
- HTTP 内容请求直接流入持久暂存文件，不先拼接完整 Buffer。服务端计算实际大小和 SHA-256；用户文件名不参与暂存路径。
- 暂存路径只接受服务器内部键，并拒绝绝对路径、点路径、符号链接逃逸和非普通文件。完整字节进入 `STAGED` 后仍未成为可下载文件。
- 未提交的唯一暂存副本不因普通期限或 LRU 删除；只有 `COMMITTED`、`CANCELLED` 或已经过期的 `FAILED` upload 可由常驻 worker 清理。
- `SERVER_VOLUME` 提交路由只接受 `STAGED` upload；最终路径由 blob UUID 派生，用户名称不参与磁盘路径。
- provider 临时文件使用 0600 权限，完成 `fsync` 后无覆盖原子发布，并从最终文件重新计算大小与 SHA-256。读取原语同样先验证完整性。
- provider 验证成功后，upload、blob、file entry/version、事件、审计和幂等响应在一个 PostgreSQL 事务提交。数据库失败保留暂存与最终 provider 字节，重试复用同一 blob 目标。
- S3 凭据使用显式实例 master key 和带配置 ID/版本 AAD 的 AES-256-GCM 密文；API、事件、审计和日志不返回凭据。
- S3 endpoint 只接受 HTTPS，并拒绝 URL 凭据、query、fragment 和危险网络目标。DNS 解析后的实际连接地址再次校验并固定，私网目标必须由系统管理员显式允许。
- S3 内容从 durable staging 流式 PUT，object key 只由管理员 prefix 和 blob UUID 派生；远端 GET 重算大小和 SHA-256 后才发布文件版本。
- 同源 HTTP 已开放文件列表、详情、下载、提交审核、发布和逻辑删除。PUBLIC 只看到公开委员会的已发布文件；member、Chair 和 Owner 可读取未删除文件。
- 下载先按不可变版本记录的 provider 校验大小和 SHA-256，再以强制附件和安全响应头流式返回；HTML、XML、JavaScript 与 SVG 不作为同源可执行内容内联。
- 逻辑删除立即不可见，并为所有版本 blob 创建 durable delete job。常驻 maintenance worker 优先执行这些任务；provider 删除失败退避重试，超时 claim 可恢复。
- provider 切换以 durable migration/item/copy 表保存；复制期间旧 binding 持续服务，manifest 改变要求显式重试，全部目标副本复验后才原子切换。
- S3 目标必须活动且当前 revision 已验证；常驻迁移 worker 使用 durable staging、claim token、退避与 stale-claim 恢复。取消副本进入 durable 删除任务。
- 实际存储挂载点达到默认 80% 时记录告警，达到 90% 时拒绝新上传字节和 provider copy；下载、议事和清理继续可用。容量未知或必要目录不可读写会使 readiness 失败。
- upload 和 provider migration staging 用独立 claim token、退避及 stale-claim 恢复清理；结果写追加式维护审计。活动、待重试或唯一暂存副本不会被清理，退休源副本也不因压力自动删除。
- `/metrics` 暴露容量比、固定类别队列深度和成功/失败计数，不包含路径、文件名或凭据。
- 自托管工作区已接入文件列表、浏览器分块 SHA-256、真实上传字节进度、取消/重试、审核、发布、attachment 下载和永久删除；危险 MIME 不进入预览 DOM。
- Chair/Owner 可查看当前 binding、初始化服务器卷或 S3、创建和操作 provider migration。系统管理员在独立页面创建、更新、停用和验证 S3 配置；浏览器不接收或回填保存的凭据。
- 文件/迁移 SSE 只触发权威快照或列表刷新。revision、幂等或资源冲突不会由客户端静默覆盖；`SYSTEM_ADMIN` 不自动显示 Chair 操作。
- Agent 配对码和设备凭据只保存哈希，明文各只返回一次。Agent 使用独立 `QuorumAgent` authorization scheme，不能调用 Session 保护的账号或议事接口。
- 一个委员会最多一个 `ACTIVE`/`DEGRADED` storage host；转移、撤销和重新配对递增单调 lease generation，旧设备写入返回 `STALE_STORAGE_LEASE`。
- 心跳超时只把 storage host 标为降级并发送 Chair 事件，不自动暂停委员会；当前 generation 的 heartbeat 可恢复在线状态。
- 文件版本和墓碑事务会追加严格递增的 Agent manifest，并为当前 host 创建 generation 固定的任务；新 host 配对时按最新 manifest 补建任务。
- Agent manifest、task、claim、complete、fail 和 blob 内容路由只接受独立设备凭据；每次状态提交复核当前 lease generation、task/file revision 和 claim token。
- Agent 内容上传直接流入 durable staging 并重算大小与 SHA-256；provider blob 下载先执行服务端完整性校验。网络传输不持有委员会行锁。
- Chair/Owner 可把当前配对 host 设为初始 `CHAIR_AGENT` binding；普通 member 和 `SYSTEM_ADMIN` 身份本身无此权限。
- 浏览器上传在完整暂存后进入 `PENDING_HOST_COMMIT`，页面从服务器恢复待保存列表；当前 Agent 完成固定 task 前不产生 file entry/version。唯一暂存副本不参与普通期限清理。
- `local-changes` 按最新 manifest、墓碑、file revision 和 lease generation 接受新增、修改、重命名或删除；新增/修改内容必须先通过 `UPLOAD_BLOB` 大小及 SHA-256 复验。
- 冲突保存为 durable 记录并返回 `CHAIR_DECISION_REQUIRED`；删除墓碑优先。主机转移取消旧 task、重排浏览器待提交 upload 和完整最新 manifest，既有文件在新 host 确认前保持 `OUT_OF_SYNC`。
- Chair 内容仅在服务器仍有已验证暂存副本时可授权下载；浏览器不会获得 Agent 地址、设备凭据、本地路径或正文。
- 独立 `packages/storage-agent` 已实现 HTTPS-only Agent client、私有配置、安全共享目录、墓碑优先 task 消费、完整性校验后的原子落盘、watcher 提示与周期全量扫描、本地变化上报、pending task 重放及 lease fencing。并发本地编辑与不安全路径 fail closed，不被静默覆盖。
- 浏览器配对、转移、撤销和冲突裁决界面已实施。仓库可生成固定运行时、自包含、可复现的 Windows x86-64、macOS x86-64/arm64 和 Linux x86-64 包；当前 WSL 只验证未签名产物，原生签名、公证和系统行为仍待实机验收。
- Committee Owner 可把活动委员会归档；归档后工作区保留受众过滤读取和文件下载，但隐藏并在服务端拒绝所有委员会、议事、文本和文件写命令。
- 归档 Owner 可流式导出同一 `REPEATABLE READ READ ONLY` 快照中的议事记录、审计和文件 manifest。导出不缓冲完整结果，排除邀请/设备/Session 等凭据、provider storage key、源 IP 摘要和文件正文。
- 归档 Owner 可在精确输入委员会名称后请求永久删除。请求原子冻结委员会并排队 provider、Agent 和 staging 清理；当前 Chair provider 不可恢复时拒绝启动，避免产生无法完成的删除。
- 删除 worker 只在所有物理副本、唯一暂存副本和本次必需的 Agent 删除任务均完成后清除数据库。清除事务由 deletion job 的当前 claim token 限定；失败整体回滚并退避重试。完成后只保留不含委员会名称明文的 durable job 结果。
- 系统管理员只能匿名化已禁用普通账号，并须选择另一个活动账号接收委员会、账号级模板与规则包。转移、委员会 revision/事件/审计、凭据与 Session 删除和个人信息清除同事务提交；历史 actor ID 保留且匿名化不可恢复。
- 常驻 retention worker 只清理过期/撤销 Session、到期幂等结果、终态一次性秘密和已决定注册申请；多实例由 advisory lock 协调，失败整体回滚。事件、审计、Agent task 和删除追踪记录默认保留，Compose 日志固定轮换上限。
- 系统管理员运行状态页只展示 schema compatibility、容量、账号/委员会数量、固定队列深度和最近 retention 结果；普通账号无权访问，响应不含业务标识、内部路径、provider key 或凭据。
- `pnpm self-host:backup -- <new-directory>` 输出 PostgreSQL custom dump、文件 provider manifest 和 SHA-256 元数据。数据库与 provider 字节不是跨介质原子快照，必须按 [`RECOVERY.md`](./RECOVERY.md) 在隔离环境核对并演练；首版不调度自动备份或自动恢复。
- PostgreSQL、TLS 浏览器和 Compose 实测尚未在当前环境执行，状态及取证要求见 [`MANUAL_ACCEPTANCE.md`](./MANUAL_ACCEPTANCE.md)。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 系统边界、身份权限、部署、实时同步与并发原则 |
| [`RULE_PACKAGE_SPEC.md`](./RULE_PACKAGE_SPEC.md) | 可组合规则包、主席裁决、版本与安全表达式契约 |
| [`DATA_API_SPEC.md`](./DATA_API_SPEC.md) | PostgreSQL 逻辑模型、HTTP 命令、错误与 SSE 事件契约 |
| [`STORAGE_AGENT_SPEC.md`](./STORAGE_AGENT_SPEC.md) | 服务器文件卷、S3 和 Chair Local Agent 协议 |
| [`AGENT_RELEASE.md`](./AGENT_RELEASE.md) | Agent 可复现发布、安装升级、签名与公证流程 |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | 分阶段实现顺序、迁移边界和验收门槛 |
| [`CURRENT_BEHAVIOR_BASELINE.md`](./CURRENT_BEHAVIOR_BASELINE.md) | 阶段 0 当前行为清单、规则 fixture 差异和稳定注册表 |
| [`MANUAL_ACCEPTANCE.md`](./MANUAL_ACCEPTANCE.md) | 当前环境无法自动执行的部署、浏览器和容量验收 |
| [`RECOVERY.md`](./RECOVERY.md) | 数据库 dump、文件 manifest、隔离恢复与校验流程 |
| [`STAGE_6_HANDOFF_PROMPT.md`](./STAGE_6_HANDOFF_PROMPT.md) | 阶段 6 服务器卷与 S3 文件实施交接 Prompt |
| [`STAGE_6_3_HANDOFF_PROMPT.md`](./STAGE_6_3_HANDOFF_PROMPT.md) | 已完成阶段 6.3 SERVER_VOLUME provider 的历史交接 Prompt |
| [`STAGE_6_4_HANDOFF_PROMPT.md`](./STAGE_6_4_HANDOFF_PROMPT.md) | 已完成阶段 6.4 S3 compatible provider 的历史交接 Prompt |
| [`STAGE_6_5_HANDOFF_PROMPT.md`](./STAGE_6_5_HANDOFF_PROMPT.md) | 已完成阶段 6.5 审核、发布、下载和永久删除的历史交接 Prompt |
| [`STAGE_6_6_HANDOFF_PROMPT.md`](./STAGE_6_6_HANDOFF_PROMPT.md) | 已完成阶段 6.6 provider 切换与失败回退的历史交接 Prompt |
| [`STAGE_6_7_HANDOFF_PROMPT.md`](./STAGE_6_7_HANDOFF_PROMPT.md) | 已完成阶段 6.7 磁盘阈值和后台清理的历史交接 Prompt |
| [`STAGE_6_8_HANDOFF_PROMPT.md`](./STAGE_6_8_HANDOFF_PROMPT.md) | 已完成阶段 6.8 自托管文件 UI 与阶段收尾的历史交接 Prompt |
| [`STAGE_7_HANDOFF_PROMPT.md`](./STAGE_7_HANDOFF_PROMPT.md) | 阶段 7 总体与 7.1 的历史交接 Prompt |
| [`STAGE_7_2_HANDOFF_PROMPT.md`](./STAGE_7_2_HANDOFF_PROMPT.md) | 已完成阶段 7.2 Agent task 与 manifest 的历史交接 Prompt |
| [`STAGE_7_3_HANDOFF_PROMPT.md`](./STAGE_7_3_HANDOFF_PROMPT.md) | 已完成阶段 7.3 Chair Agent provider 与恢复编排的历史交接 Prompt |
| [`STAGE_7_4_HANDOFF_PROMPT.md`](./STAGE_7_4_HANDOFF_PROMPT.md) | 已完成阶段 7.4 桌面 Agent 文件系统核心的历史交接 Prompt |
| [`STAGE_7_5_HANDOFF_PROMPT.md`](./STAGE_7_5_HANDOFF_PROMPT.md) | 已完成阶段 7.5 Agent 管理与冲突裁决 UI 的历史交接 Prompt |
| [`STAGE_7_6_HANDOFF_PROMPT.md`](./STAGE_7_6_HANDOFF_PROMPT.md) | 已完成阶段 7.6 桌面发布包的历史交接 Prompt |
| [`RUNNING_LOG.md`](./RUNNING_LOG.md) | 长任务当前进度、验证结果和下一步恢复点 |

## 当前实施与验证约束

- 在取得服务器前继续按 `IMPLEMENTATION_PLAN.md` 完成可离线开发的迁移阶段，不把缺少服务器作为停止编码的理由。
- 每次只完成一个阶段。上一阶段的代码、自动测试和文档形成基线后再进入下一阶段，不在一个改动中跨越多个尚未验证的业务领域。
- 能自动验证的要求必须写成单元、契约、HTTP、数据库集成或前端测试。不得仅把可自动化项目列为人工验收。
- PostgreSQL 集成测试必须连接真实 PostgreSQL，并使用独立临时数据库。环境缺少数据库时可以明确跳过，但不得改用内存数据库冒充 PostgreSQL 验证。
- 依赖真实服务器、Docker、Caddy、浏览器、TLS、持久卷或容量环境的项目统一记录在 [`MANUAL_ACCEPTANCE.md`](./MANUAL_ACCEPTANCE.md)。每项记录前置条件、步骤、通过条件、证据和状态。
- 延期验收必须标明未执行原因。单元测试、mock、静态配置检查和构建成功不能替代容器、浏览器、网络、持久性或容量证据。
- 取得服务器后按人工验收清单补测，不因后续阶段已经实现而跳过较早阶段的部署验收。
- 浏览器源码、依赖、Functions/Rules/emulator 资产和生产构建中的旧运行依赖已删除；历史基线与交接文档只作为迁移证据保留。

## 已确认的产品决策

- 首版面向公网部署，后续支持局域网独立部署；两种模式使用同一应用代码。
- 首版仅系统管理员创建账号；未来允许自行注册并由管理员审批。
- 委员会可设为公开或私有；匿名访问者不能参与正式议事操作。
- 席位由管理员分配，也可通过席位邀请码加入；一个席位可绑定多名代表。
- 每一轮正式表决中每个席位最多一张当前有效票；代表默认不能改票，主席可以执行可审计的更正。
- Strawpoll 可由主席选择席位实名模式或匿名模式；匿名结果不得转换为正式表决结果。
- 委员会有 `DELEGATE_OPERATED` 和 `CHAIR_OPERATED` 两种运作模式。主席在两种模式下都拥有代任意席位执行议事动作的能力。
- 只有明确授予 `CHAIR` 能力的用户拥有最高议事权；系统管理员不会自动成为学术裁决者。
- 陈旧的普通写入返回 `409 Conflict`。主席需要显式覆盖；覆盖记录原版本、操作者和裁决。
- 委员会可选服务器文件卷、Chair Local Agent 或 S3 兼容对象存储。Chair Agent 离线只产生警告，不自动暂停会议。
- 文件删除对用户立即且永久生效；系统保留不可恢复的删除墓碑，防止离线副本复活已删除文件。
- 账号先禁用，转移资源归属后才能匿名化；历史议事和审计记录不级联删除。
- 会议结束后进入只读归档，由主席手动永久删除。
- 不迁移当前 Firebase 数据；当前没有需要切换的生产数据。
- 首版不提供计划备份，但数据布局和部署方式不得阻碍日后增加备份。

## 核心原则

### 主席主导，规则辅助

规则包提供默认值、门槛计算、流程建议和偏离提示，不充当不可绕过的自动裁判。主席可以覆盖所有学术和议事规则；身份真实性、审计不可变性、票唯一性、存储 fencing、事务和引用完整性属于不可覆盖的系统约束。

### 一个业务真相

PostgreSQL 是账号、权限、议事状态、文件元数据和事件游标的唯一业务真相。SSE 是传输通道，事件表用于断线补偿；两者都不是第二套业务数据库。

### 显式业务命令

不把 Firebase 路径机械翻译成通用 CRUD API。点名、动议、表决、计时器、主席代办、文件发布等操作通过表达意图的服务端命令执行，并在一个数据库事务中完成授权、规则评估、状态修改、事件和审计记录。

### 模块化单体优先

首版采用 Node.js 22 + TypeScript 模块化单体和 PostgreSQL。目标部署为腾讯云 Ubuntu x86-64、2 核、2 GiB 内存、40 GiB SSD；不在首版引入微服务、Kafka 或 Redis 等非必要常驻依赖。
