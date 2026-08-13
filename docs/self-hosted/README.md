# Quorum 自托管目标架构

本目录描述 Quorum 从 Firebase BaaS 迁移到完全自主托管后的目标架构。阶段 0–5 已落地：契约、后端与部署骨架、身份、委员会核心领域、规则包、低并发业务切片，以及实时与高并发议事。阶段 6 的服务器卷和 S3 文件尚未实施；仓库仍未完成全部迁移。当前事实以根目录的 [`PROJECT_ARCHITECTURE.md`](../../PROJECT_ARCHITECTURE.md) 为准。

## 当前阶段 5 边界

- PostgreSQL migration 已建立身份、凭据、Session、系统设置、未来注册申请和身份审计表。
- bootstrap secret 只保存哈希，并由 PostgreSQL 事务保证并发初始化只有一个成功；公开状态 API 不返回 secret。
- 密码使用 Argon2id；Session token 只保存哈希；Cookie、CSRF、Origin、限流、锁定和 Session 轮换在服务端执行。
- 自主托管前端已接入首次管理员、登录、强制修改临时密码、退出和账号管理。
- `VITE_RUNTIME_MODE=self-hosted` 显示自主托管身份、账号管理、委员会、模板和议事工作区；默认和 `firebase` 模式保持现有 Firebase 页面，因此没有双写。
- PostgreSQL 已建立委员会、membership、Chair capability、席位、席位历史、邀请码、规则包版本、规则绑定、主席覆盖、委员会事件和业务审计。
- 同源 API 已提供阶段 3 委员会、席位、邀请码、快照和规则包命令。所有写入继续执行 Session、CSRF 和 Origin 校验。
- Committee Owner、Chair、membership、seat assignment 和 `SYSTEM_ADMIN` 分别授权。系统管理员和 Committee Owner 都不会隐式获得 Chair 能力。
- 邀请码只保存哈希；规则模拟不写议事状态；内置包和已发布版本不可原地修改。
- schema compatibility 12 覆盖阶段 4 低并发表和阶段 5 的事件游标、计时器、名单、发言、动议、ballot、意向性投票与版本化决议草案。
- 自托管 React 页面只调用同源 API；一浏览器一委员会一条 SSE，游标过期、序号缺口或未知事件回退完整快照。
- 服务器时间是计时真相；PostgreSQL 唯一约束和行锁保护队列顺序、当前发言人及一席一票。
- 正式 ballot 冻结资格、门槛、must-vote、否决席位和规则版本；票更正追加历史，匿名意向性投票不保存投票人与选项关联。
- 决议草案和修正案使用不可变版本；进入表决的版本由数据库约束冻结。
- 本阶段不提供文件 provider、上传或 Local Agent。
- PostgreSQL、TLS 浏览器和 Compose 实测尚未在当前环境执行，状态及取证要求见 [`MANUAL_ACCEPTANCE.md`](./MANUAL_ACCEPTANCE.md)。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 系统边界、身份权限、部署、实时同步与并发原则 |
| [`RULE_PACKAGE_SPEC.md`](./RULE_PACKAGE_SPEC.md) | 可组合规则包、主席裁决、版本与安全表达式契约 |
| [`DATA_API_SPEC.md`](./DATA_API_SPEC.md) | PostgreSQL 逻辑模型、HTTP 命令、错误与 SSE 事件契约 |
| [`STORAGE_AGENT_SPEC.md`](./STORAGE_AGENT_SPEC.md) | 服务器文件卷、S3 和 Chair Local Agent 协议 |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | 分阶段实现顺序、迁移边界和验收门槛 |
| [`CURRENT_BEHAVIOR_BASELINE.md`](./CURRENT_BEHAVIOR_BASELINE.md) | 阶段 0 当前行为清单、规则 fixture 差异和稳定注册表 |
| [`MANUAL_ACCEPTANCE.md`](./MANUAL_ACCEPTANCE.md) | 当前环境无法自动执行的部署、浏览器和容量验收 |
| [`STAGE_6_HANDOFF_PROMPT.md`](./STAGE_6_HANDOFF_PROMPT.md) | 阶段 6 服务器卷与 S3 文件实施交接 Prompt |

## 当前实施与验证约束

- 在取得服务器前继续按 `IMPLEMENTATION_PLAN.md` 完成可离线开发的迁移阶段，不把缺少服务器作为停止编码的理由。
- 每次只完成一个阶段。上一阶段的代码、自动测试和文档形成基线后再进入下一阶段，不在一个改动中跨越多个尚未验证的业务领域。
- 能自动验证的要求必须写成单元、契约、HTTP、数据库集成或前端测试。不得仅把可自动化项目列为人工验收。
- PostgreSQL 集成测试必须连接真实 PostgreSQL，并使用独立临时数据库。环境缺少数据库时可以明确跳过，但不得改用内存数据库冒充 PostgreSQL 验证。
- 依赖真实服务器、Docker、Caddy、浏览器、TLS、持久卷或容量环境的项目统一记录在 [`MANUAL_ACCEPTANCE.md`](./MANUAL_ACCEPTANCE.md)。每项记录前置条件、步骤、通过条件、证据和状态。
- 延期验收必须标明未执行原因。单元测试、mock、静态配置检查和构建成功不能替代容器、浏览器、网络、持久性或容量证据。
- 取得服务器后按人工验收清单补测，不因后续阶段已经实现而跳过较早阶段的部署验收。
- Firebase 旧栈与 PostgreSQL 新栈在迁移期间通过显式配置二选一。同一业务动作不得双写；只有全部纵向切片通过验收后才能删除 Firebase 运行路径。

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
