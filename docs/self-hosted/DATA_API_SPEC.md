# 数据与 API 规格 v0.1

## 1. 数据库约定

- PostgreSQL 使用 UTC `timestamptz`。
- 业务主键使用 UUID；委员会内事件使用单调递增 `bigint sequence`。
- 可由用户并发修改的聚合根保存整数 `revision`。
- 外键默认限制删除；需要保留历史的关系保存显示名快照，不依赖已匿名化用户。
- JSONB 仅用于规则定义、模板 definition、事件 payload 和结构变化频繁的附加信息；正式运行状态使用关系表。
- 每个业务命令、outbox 事件和审计记录在同一事务中提交。

## 2. 身份与系统表

### `users`

```text
id uuid primary key
email citext unique not null
display_name text not null
status enum(ACTIVE, DISABLED, ANONYMIZED)
is_system_admin boolean not null default false
session_version integer not null default 1
must_change_password boolean not null default true
created_at, updated_at, disabled_at, anonymized_at
```

邮箱规范化后唯一。匿名化会清除邮箱和个人显示名，但不删除被其操作的历史记录。

### `user_credentials`

```text
user_id uuid primary key references users
password_hash text not null
password_changed_at timestamptz not null
failed_attempts integer not null default 0
locked_until timestamptz
```

### `sessions`

```text
id uuid primary key
user_id uuid not null references users
token_hash bytea unique not null
session_version integer not null
expires_at, last_seen_at, created_at
revoked_at
ip_hash, user_agent_summary
```

### `system_settings`

单行保存实例初始化状态、注册策略、schema 兼容版本和非机密运行设置。bootstrap secret 只保存哈希，初始化成功后清除。

### `registration_requests`

为未来自助注册预留；首版 API 不开放创建入口。

## 3. 委员会、能力与席位

### `committees`

```text
id uuid primary key
owner_user_id uuid not null references users
name, chair_label, topic, conference
visibility enum(PUBLIC, PRIVATE)
operation_mode enum(DELEGATE_OPERATED, CHAIR_OPERATED)
status enum(ACTIVE, PAUSED, ARCHIVED, DELETING)
active_rule_package_version_id uuid not null
active_storage_binding_id uuid
revision integer not null default 1
created_at, updated_at, archived_at
```

### `committee_memberships`

表示用户能否进入私有委员会及其成员状态，不承担席位或主席能力。

```text
committee_id, user_id primary key
status enum(INVITED, ACTIVE, SUSPENDED, LEFT)
joined_at, updated_at
```

### `committee_capabilities`

```text
committee_id, user_id, capability primary key
capability enum(CHAIR)
granted_by_user_id
granted_at, revoked_at
```

委员会所有权单独保存在 `committees.owner_user_id`。Committee Owner 可以任命 Chair；只有未撤销的 `CHAIR` 能力拥有议事最高权限。

### `committee_seats`

```text
id uuid primary key
committee_id uuid not null
stable_key text not null
display_name text not null
rank text
can_vote boolean not null
has_veto boolean not null
sort_order integer not null
active boolean not null default true
revision integer not null default 1
unique(committee_id, stable_key)
```

### `seat_assignments`

```text
id uuid primary key
committee_id, seat_id, user_id
status enum(ACTIVE, ENDED)
assigned_by_user_id
assigned_at, ended_at
```

一个席位可有多个活动用户；一个用户在同一委员会最多一个活动席位，使用部分唯一索引保证。历史行不删除。

### `seat_invitations`

只保存邀请码哈希、目标席位、有效期、使用次数限制和撤销状态。兑换后创建 membership 与 assignment，不能由客户端指定另一个席位。

## 4. 出席、阶段与问题

### `meeting_sessions`

表示一个分组会议或连续会期，保存当前阶段、当前规则版本、状态和 revision。

### `roll_calls`、`roll_call_entries`

每次点名单独保存。entry 记录席位、回答类型、实际录入者、是否主席代办及时间。点名完成后生成出席快照；之后临时离场使用 attendance event，不改写原点名回答。

### `attendance_events`

```text
id, committee_id, meeting_session_id, seat_id
type enum(PRESENT, TEMPORARILY_LEFT, RETURNED, ABSENT)
actor_user_id, on_behalf_of_seat_id
source_point_id
created_at
```

当前出席状态由最后有效事件物化并可重建。

### `points`

```text
id, committee_id, meeting_session_id
point_type_id, content
raised_by_seat_id
actor_user_id, on_behalf_of_seat_id
interrupt_requested boolean
status enum(PENDING, UPHELD, OVERRULED, ANSWERED, RESOLVED, REJECTED)
chair_response
resolved_by_user_id, created_at, resolved_at
rule_package_version_id
```

问题类型由规则包定义。接受个人特权问题不会直接篡改点名记录；如需改变出席状态，创建关联的 attendance event。

## 5. 发言、动议与计时器

### `speaker_lists`

保存类型、状态、当前发言、默认时长、关联 caucus 和 revision。GSL 是 `kind = GENERAL` 的普通列表，不使用特殊固定路径。

### `speaker_requests`

代表申请与进入队列是不同动作。请求保存提出者席位、实际操作者、规则评估结果和主席裁决。

### `speaker_queue_entries`

保存稳定顺序键、席位、speech kind、来源请求和状态。同一席位是否可重复由规则包评估；数据库只保证队列结构有效。

### `speaker_actions`

追加记录开始、暂停、继续、完成、跳过、移序和让渡。统计和审计不依赖可变的人名。

### `caucuses`

保存有主持或自由磋商的主题、状态、总时间、单人时间、来源动议和关联名单。

### `motions`

```text
id, committee_id, meeting_session_id
motion_type_id
proposed_by_seat_id
actor_user_id, on_behalf_of_seat_id
parameters jsonb
status enum(PENDING, SECONDED, VOTING, PASSED, FAILED, WITHDRAWN, SUPERSEDED)
rule_package_version_id
rule_evaluation jsonb
decided_at, created_at
revision
```

### `motion_seconds`

按席位记录附议和实际操作者。规则包决定需要多少附议；主席可以裁决继续，但实际缺少的附议不会被伪造成存在。

### `timer_states`

```text
id, committee_id, owner_type, owner_id
running boolean
started_at timestamptz
remaining_at_start_ms bigint
elapsed_before_start_ms bigint
revision integer
updated_at
```

客户端按服务器时间显示；开始、暂停、重置、延长和过期才写数据库。后台任务可以产生一次性 `timer.expired` 事件，但任何服务端业务命令都必须自行按当前时间重新判断。

## 6. 文件、决议和讨论

建议按业务资源拆分：

```text
documents
document_versions
document_sponsors
document_signatories
resolutions
amendments
discussion_entries
```

`documents` 保存规则包定义的文件类型和审核状态；二进制内容通过 `file_entries` 关联。决议文本修改创建版本，已进入表决的版本不可被静默替换。

## 7. Ballot 与选票

### `ballots`

用于动议、修正案、决议及其他正式表决：

```text
id, committee_id, subject_type, subject_id
status enum(DRAFT, OPEN, CLOSED, PUBLISHED, REOPENED)
voting_mode, choices jsonb
rule_package_version_id
eligibility_snapshot jsonb
threshold_definition jsonb
threshold_value integer
opened_by_user_id, opened_at, closed_at, published_at
revision
```

### `ballot_votes`

```text
id, ballot_id, seat_id
current_choice
cast_by_user_id
cast_on_behalf boolean
cast_at
revision
unique(ballot_id, seat_id)
```

### `ballot_vote_revisions`

每次首次投票和主席更正都追加历史：旧值、新值、实际操作者、代表席位、理由和时间。代表默认不能修改；主席使用专用更正命令。

### `strawpolls`、`strawpoll_options`

`voting_mode` 为 `SEAT_AUTHENTICATED` 或 `ANONYMOUS`。席位模式复用一席一票语义。匿名模式使用不可猜测访问 token、由 Session 派生的 poll 专用凭证和限流；匿名票不保存为正式 ballot，也不能转换成正式结果。

## 8. 规则、事件、审计和后台任务

### 规则表

见 [`RULE_PACKAGE_SPEC.md`](./RULE_PACKAGE_SPEC.md)：

```text
rule_packages
rule_package_versions
committee_rule_bindings
chair_rule_overrides
```

### `committee_events`

```text
committee_id
sequence bigint
event_type text
resource_type text
resource_id uuid
resource_revision integer
payload jsonb
audience enum(PUBLIC, MEMBER, CHAIR)
created_at
primary key(committee_id, sequence)
```

事件 payload 不包含秘密和无权受众字段。SSE 建立时按当前身份重新过滤，不能因为用户过去有权限就发送旧的 Chair-only payload。

### `audit_log`

```text
id, request_id, committee_id
actor_user_id, effective_capabilities
on_behalf_of_seat_id
action, resource_type, resource_id
result, reason
before_summary, after_summary
source_ip_hash, user_agent_summary
created_at
```

应用账号只能插入，不能更新或删除。密码、Session token、文件正文和 S3 密钥不得进入审计内容。

### `idempotency_keys`

按用户、路由和 key 唯一，保存请求哈希、响应状态和响应摘要。相同 key 携带不同请求时返回冲突。

### `background_jobs`

用于计时器过期、文件同步、清理过期 Session、事件保留和存储切换。任务有锁定租约、重试次数、下次执行时间和最终失败状态。

## 9. HTTP API 约定

所有业务 API 位于 `/api/v1`，前端与 API 同源。成功响应使用：

```json
{
  "data": {},
  "meta": {
    "requestId": "..."
  }
}
```

错误使用：

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "This item changed since it was loaded.",
    "details": {
      "currentRevision": 39
    },
    "requestId": "..."
  }
}
```

`message` 是安全、简短的用户提示；日志通过 `requestId` 关联内部错误，不把堆栈返回浏览器。

主要状态码：

| 状态 | 使用场景 |
| --- | --- |
| `400` | 请求格式无法解析 |
| `401` | 未登录或 Session 失效 |
| `403` | 当前身份没有能力 |
| `404` | 对象不存在或不应向调用者暴露其存在 |
| `409` | revision、幂等 key 或唯一性冲突 |
| `410` | SSE 游标已过期或匿名链接已失效 |
| `413` | 上传超过限制 |
| `422` | 业务内容无效或需要主席裁决 |
| `429` | 登录、匿名投票或 API 频率超限 |

`/health/live` 和 `/health/ready` 是部署探针，不属于业务 API；前者只判断进程存活，后者同时检查数据库 migration 兼容性和必要存储可用性。

## 10. 命令封装

主席代办和规则裁决字段统一进入命令 envelope：

```json
{
  "baseRevision": 12,
  "onBehalfOfSeatId": "seat-uuid",
  "ruleDecision": {
    "evaluationId": "evaluation-uuid",
    "action": "PROCEED_ONCE",
    "reason": null
  },
  "payload": {}
}
```

`onBehalfOfSeatId` 只对 Chair 开放。代表命令的席位由服务端从 Session 和 assignment 推导，忽略或拒绝客户端冒充字段。

## 11. 核心路由

### 身份

```text
POST /api/v1/bootstrap/admin
GET  /api/v1/bootstrap/status
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/elevate
POST /api/v1/auth/change-password
GET  /api/v1/auth/me

GET  /api/v1/admin/users
POST /api/v1/admin/users
POST /api/v1/admin/users/:id/reset-password
POST /api/v1/admin/users/:id/disable
POST /api/v1/admin/users/:id/revoke-sessions
POST /api/v1/admin/users/:id/anonymize
```

`bootstrap/status` 只返回是否已经初始化，不返回 secret。`auth/elevate` 在密码确认成功后轮换当前 Session ID。`admin/users/:id/anonymize` 属于阶段 8；阶段 2 没有实现该路由。

### 委员会与席位

```text
POST /api/v1/committees
GET  /api/v1/committees/:id/snapshot
PATCH /api/v1/committees/:id
POST /api/v1/committees/:id/archive
DELETE /api/v1/committees/:id

POST /api/v1/committees/:id/chairs
DELETE /api/v1/committees/:id/chairs/:userId
POST /api/v1/committees/:id/seats
POST /api/v1/committees/:id/seat-assignments
POST /api/v1/committees/:id/seat-invitations
POST /api/v1/committees/:id/seat-invitations/:invitationId/revoke
POST /api/v1/seat-invitations/redeem
POST /api/v1/committees/:id/operation-mode
POST /api/v1/committees/:id/status
```

### 议事命令

```text
POST /api/v1/committees/:id/roll-calls
POST /api/v1/roll-calls/:id/record-response
POST /api/v1/committees/:id/attendance-events

POST /api/v1/committees/:id/points
POST /api/v1/points/:id/resolve

POST /api/v1/committees/:id/speaker-lists
POST /api/v1/speaker-lists/:id/queue
POST /api/v1/speaker-lists/:id/advance
POST /api/v1/speaker-lists/:id/reorder
POST /api/v1/speaker-lists/:id/speech/{start,pause,resume,complete}
POST /api/v1/speeches/:id/yield
POST /api/v1/speeches/:id/contributions

POST /api/v1/committees/:id/motions
POST /api/v1/motions/:id/second
POST /api/v1/motions/:id/decide

POST /api/v1/committees/:id/timers
POST /api/v1/timers/:id/start
POST /api/v1/timers/:id/pause
POST /api/v1/timers/:id/resume
POST /api/v1/timers/:id/reset
POST /api/v1/timers/:id/extend
POST /api/v1/timers/:id/expire

POST /api/v1/committees/:id/ballots
POST /api/v1/ballots/:id/votes
POST /api/v1/ballots/:id/correct-vote
POST /api/v1/ballots/:id/close
POST /api/v1/ballots/:id/publish

POST /api/v1/committees/:id/strawpolls
POST /api/v1/strawpolls/:id/votes
POST /api/v1/strawpolls/:id/close

POST /api/v1/committees/:id/resolutions
POST /api/v1/resolutions/:id/amendments
POST /api/v1/documents/:id/versions
POST /api/v1/documents/:id/commands
POST /api/v1/documents/:id/discussion
```

### 规则与实时

```text
GET  /api/v1/rule-packages
POST /api/v1/rule-packages/import
POST /api/v1/rule-packages/:id/clone
POST /api/v1/rule-packages/:id/versions
POST /api/v1/rule-package-versions/:id/validate
POST /api/v1/rule-package-versions/:id/simulate
POST /api/v1/committees/:id/rules/activate
POST /api/v1/committees/:id/rules/overrides

GET  /api/v1/committees/:id/events?after=:sequence
```

## 11.1 阶段 3 命令契约

阶段 3 的委员会写请求必须携带同源 Session、允许的 `Origin` 和匹配的 CSRF token。服务端从 Session 推导 actor；请求体不接受 owner、Chair 或 capability。创建委员会的最小请求为：

```json
{
  "name": "联合国安全理事会",
  "visibility": "PRIVATE",
  "operationMode": "DELEGATE_OPERATED",
  "activeRulePackageVersionId": "可选的已发布版本 UUID"
}
```

省略规则版本时，服务端选择内置 `Quorum Default`。创建者成为 Committee Owner，但不会自动获得 Chair capability。`PATCH /committees/:id` 只接受 `{baseRevision, patch}`；`patch` 只可包含 `name`、`chairLabel`、`topic`、`conference` 和 `visibility`，不能修改 owner、状态、运作模式或规则绑定。

Chair 任免、归档、删除状态转换、运作模式和活动状态命令都使用 `baseRevision`。`POST /status` 只接受 `ACTIVE` 或 `PAUSED`。删除命令把委员会转为 `DELETING`，不在阶段 3 物理删除历史。只有 Committee Owner 可任免 Chair、归档或删除；只有有效 Chair 可切换运作模式与活动状态。

席位命令使用以下请求：

```json
{"stableKey":"china","displayName":"中国","rank":"VETO","canVote":true,"hasVeto":true,"sortOrder":1}
{"seatId":"席位 UUID","userId":"用户 UUID"}
{"action":"END","assignmentId":"席位分配 UUID"}
{"seatId":"席位 UUID","maxUses":1,"expiresAt":"2026-08-13T00:00:00.000Z"}
```

同一席位可有多个活动用户；部分唯一索引限制一个用户在同一委员会最多一个活动席位。结束分配会保留历史行。创建邀请码时响应返回一次 `code`；后续查询、事件、审计和日志均不返回明文。`POST /seat-invitations/redeem` 只接受 `{code}`，目标委员会和席位来自邀请码记录。

`GET /committees/:id/snapshot` 可匿名读取 PUBLIC 委员会。PRIVATE 委员会只允许 Owner、Chair 或活动 membership 读取；其他调用统一返回 404。匿名快照只含委员会公开字段、活动席位、`schemaVersion`、`revision` 和 `committeeEventSequence`。member 只额外收到自己的 membership 与活动 assignment；Chair 和 Owner 收到委员会的 membership、Chair 和 assignment 数据。任何快照都不含邮箱、邀请码、哈希、内部 capability 行、审计或 Session 数据。

规则包导入请求为 `{scope, committeeId?, definition}`。`SYSTEM` 只允许系统管理员；`COMMITTEE` 只允许目标委员会 Chair。克隆请求补充新 `key` 和目标 scope；版本请求为 `{definition, publish}`。内置包不可创建版本，已发布版本由数据库触发器禁止更新或删除。

校验返回 `{valid, issues}`。模拟请求为 `{facts}`，只返回已解析值、声明式 `plannedEffects` 和执行步数。模拟不写委员会业务状态。激活请求为 `{baseRevision, rulePackageVersionId}`，只允许 Chair 激活已发布且通过校验的版本。

主席覆盖请求为：

```json
{"scope":"ONCE","path":"ballots.delegateMayChangeVote","value":true,"operationKey":"命令幂等标识"}
{"scope":"FUTURE","path":"ballots.delegateMayChangeVote","value":true}
```

`ONCE` 只保存该操作的裁决记录。`FUTURE` 从当前活动定义创建新的不可变委员会规则版本；它不会自动激活新版本。阶段 3 拒绝 `CURRENT_PROCESS`，也不会调用计时器、队列、动议或表决命令。

## 11.2 阶段 4 低并发命令契约

阶段 4 只实现委员会资料、账号模板、席位快照、笔记、普通文本帖子、会期、点名、出席事件和问题。HTTP 响应可以返回最新资源或委员会工作区快照；本阶段不开放 SSE，也不实现阶段 5 的议事资源。

### 状态与权限矩阵

`ACTIVE` 允许全部阶段 4 命令。`PAUSED` 允许资料、席位、模板、笔记和文本帖子管理，但拒绝会期、点名、出席和问题命令。`ARCHIVED` 与 `DELETING` 拒绝全部写入。读取仍按委员会可见性和访问者 audience 过滤。

| 资源或命令 | member | Chair | Owner | `SYSTEM_ADMIN` |
| --- | --- | --- | --- | --- |
| 账号级委员会/国家模板 | 仅本人账号 | 仅本人账号 | 仅本人账号 | 仅本人账号，不可读取他人模板 |
| 委员会资料 | 读 | 读 | 写 | 无隐式权限 |
| 席位创建、编辑、停用和排序 | 读 | 写 | 无 Chair 时只读 | 无隐式权限 |
| 笔记 | 读写 | 读写 | 读写 | 无隐式权限 |
| 普通文本帖子 | 创建；编辑/删除本人帖子 | 创建；编辑/删除全部 | 创建；编辑/删除全部 | 无隐式权限 |
| 会期、点名和出席事件 | 读 | 写 | 无 Chair 时只读 | 无隐式权限 |
| `DELEGATE_OPERATED` 提出问题 | 仅自己的活动席位 | 可代任意活动席位 | 仅有活动席位时代表自己 | 无隐式权限 |
| `CHAIR_OPERATED` 提出问题 | 只读 | 可代任意活动席位 | 只读，除非同时是 Chair | 无隐式权限 |
| 主席回应 | 读 | 写 | 无 Chair 时只读 | 无隐式权限 |

Owner、Chair、membership 与活动 assignment 始终分别判断。服务端从 Session 推导实际 actor；客户端不能提交 owner、actor、用户邮箱、capability 或代表名称。

### 账号级国家模板

```text
GET    /api/v1/country-templates
POST   /api/v1/country-templates
GET    /api/v1/country-templates/:id
PUT    /api/v1/country-templates/:id
POST   /api/v1/country-templates/:id/clone
DELETE /api/v1/country-templates/:id
```

列表包含只读 `builtin:default` 和当前账号自己的模板。自定义资源使用 UUID；API 的稳定 key 为 `custom:<uuid>`。创建请求为：

```json
{
  "names": {"zh-CN": "默认国家", "en": "Default countries"},
  "defaultLanguage": "zh-CN",
  "countryLanguages": ["zh-CN", "en"],
  "countries": [{
    "stableKey": "china",
    "names": {"zh-CN": "中国", "en": "China"},
    "defaultLanguage": "zh-CN",
    "continent": "Asia",
    "sortOrder": 10,
    "flag": {"type": "STANDARD", "value": "cn"}
  }]
}
```

`PUT` 使用 `{baseRevision, template}`，整体替换该账号模板的受控定义，但不接受未知字段或任意 JSON patch。国家语言必须作为 `countryLanguages` 的整列声明；每个国家至少有一个非空名称。显示名回退为当前界面语言、模板或国家的默认语言、其他非空名称。

国旗类型只接受 `STANDARD`、`EMOJI` 和 `IMAGE`。标准国旗值是两个 ASCII 字母；Emoji 限 32 UTF-8 字节；图片必须是合法的 `data:image/webp;base64,...`，解码后不超过 256 KiB，VP8/VP8L/VP8X 尺寸不超过 256×160。服务端不接受浏览器声明的 MIME 或尺寸作为验证依据。

内置模板可读取和克隆，修改或删除返回 403。删除被当前账号任一委员会模板引用的国家模板返回 `409 RESOURCE_CONFLICT`，`details.templates` 只列出调用者自己的占用模板 ID 和显示名。

### 账号级委员会模板

```text
GET    /api/v1/committee-templates
POST   /api/v1/committee-templates
GET    /api/v1/committee-templates/:id
PUT    /api/v1/committee-templates/:id
POST   /api/v1/committee-templates/:id/clone
DELETE /api/v1/committee-templates/:id
```

创建和 `PUT` 的 `template` 包含 `names`、`defaultLanguage`、`countryTemplateKey` 和 `members`。每个 member 包含稳定 key、多语言名称、`STANDARD|VETO|NGO|OBSERVER`、`canVote`、`hasVeto`、`mustVote`、排序和国旗。三项表决属性分别保存：`canVote` 表示正式表决资格，`hasVeto` 表示否决权，`mustVote` 表示出席并参与表决时不得弃权。

同一账号的多个委员会模板可以引用同一个国家模板。引用必须指向 `builtin:default` 或当前账号仍存在的国家模板。克隆生成独立 UUID 和 revision 1；后续修改或删除源模板不改变克隆。

委员会创建扩展为：

```json
{
  "name": "联合国安全理事会",
  "visibility": "PRIVATE",
  "operationMode": "DELEGATE_OPERATED",
  "committeeTemplateId": "可选 UUID",
  "countryTemplateKey": "未选择委员会模板时必填"
}
```

选择 `committeeTemplateId` 时，服务端在创建委员会的同一事务中复制模板成员、国旗和排序为席位快照。未选择委员会模板时必须提交可访问的 `countryTemplateKey`，委员会保留临时模板语义但不自动创建席位。阶段 4 不提供按显示名重新应用模板；既有委员会席位不会随模板变化。

### 席位快照

阶段 3 的创建席位请求扩展 `mustVote` 和 `flag`。编辑、停用与排序统一使用受控席位命令：

```text
PUT /api/v1/committees/:id/seats/:seatId
```

```json
{
  "baseRevision": 3,
  "patch": {"displayName": "中华人民共和国", "sortOrder": 10}
}
```

`patch` 只接受 `displayName`、`rank`、`canVote`、`hasVeto`、`mustVote`、`sortOrder`、`flag` 和 `active`。陈旧 revision 返回 409。历史点名、问题和出席记录保存 seat UUID 与当时显示名快照；不会反查当前模板或当前席位名称。

### 笔记与普通文本帖子

```text
POST   /api/v1/committees/:id/notes
PUT    /api/v1/notes/:id
DELETE /api/v1/notes/:id

POST   /api/v1/committees/:id/text-posts
PUT    /api/v1/text-posts/:id
DELETE /api/v1/text-posts/:id
```

创建接受 `title`、`content` 和可选 `sortOrder`；Chair 创建帖子时还可提交 `onBehalfOfSeatId`。笔记标题限 200 字符、正文限 100,000 字符；帖子标题限 200 字符、正文限 20,000 字符。UTF-8 请求正文仍受全局 payload 限制。接口拒绝 `html`、`file`、`filename`、`url`、附件和其他未知字段；正文按纯文本保存和渲染。

更新请求为 `{baseRevision, patch}`，`patch` 只接受标题、正文和排序。删除采用软删除：资源正文清空并保存 `deleted_at`，事件与审计只记录 ID、revision、字符数和 SHA-256 摘要，不记录正文。普通 member 只能编辑或删除自己创建的帖子；Chair 与 Owner 可以管理全部文本帖子。所有 member、Chair 和 Owner 都可读写委员会笔记。

创建命令要求 `Idempotency-Key`。相同用户、路由、key 与相同请求返回原响应；同 key 不同请求返回 `409 IDEMPOTENCY_CONFLICT`。

### meeting session、点名和出席

```text
POST /api/v1/committees/:id/meeting-sessions
POST /api/v1/meeting-sessions/:id/close
POST /api/v1/committees/:id/roll-calls
POST /api/v1/roll-calls/:id/record-response
POST /api/v1/roll-calls/:id/undo
POST /api/v1/roll-calls/:id/reset
POST /api/v1/committees/:id/attendance-events
```

每个委员会最多一个 `OPEN` meeting session。创建请求可省略 `phaseId`；服务端选择活动规则包的第一项 phase，若规则包没有 phase 则使用稳定值 `open-debate`。会期冻结创建时的活动规则版本。关闭使用会期 `baseRevision`，只允许没有进行中点名的会期。

开始点名请求为 `{meetingSessionId}`，要求 `Idempotency-Key`。同一会期最多一个 `IN_PROGRESS` 点名。点名冻结规则版本、`attendance.responses`、开始时的活动席位顺序和每个席位显示名。规则响应为空、重复或包含未知值时返回 422。

记录请求为 `{baseRevision, seatId, response}`。只接受冻结名单中尚未记录的席位和冻结回答；每次成功递增 roll call revision 并移动 `currentSeatId`。最后一席成功后把点名标记为 `COMPLETED`，并为每席追加来源为 roll-call entry 的 `PRESENT` 或 `ABSENT` attendance event。`PRESENT_AND_VOTING` 映射为当前出席 `PRESENT`，但 entry 保留原回答。并发请求以 roll call 行锁和 revision 保证只有一个成功。

`undo` 只撤销当前 `IN_PROGRESS` 点名的最后一个 entry：entry 保存撤销时间，不物理删除；点名恢复该席位为当前席位。完成后的点名不可撤销。`reset` 把当前点名标记 `ABANDONED` 并在同一会期创建新的 `IN_PROGRESS` 点名；旧 entries 保留。它不修改已完成点名或其 attendance events。

出席事件请求为 `{meetingSessionId, seatId, type}`，type 为 `PRESENT`、`TEMPORARILY_LEFT`、`RETURNED` 或 `ABSENT`。仅 Chair 可提交；actor 来自 Session，`on_behalf_of_seat_id` 固定为目标席位。当前状态由最后一个有效事件物化为 `PRESENT`、`TEMPORARILY_LEFT` 或 `ABSENT`，并可按事件顺序重建。事件追加不改写点名 entry。

### 问题及主席回应

```text
POST /api/v1/committees/:id/points
POST /api/v1/points/:id/resolve
```

创建请求为 `{meetingSessionId, pointTypeId, content, onBehalfOfSeatId?}`。正文限 4,000 字符。服务端从会期冻结的已发布规则版本读取 `points`；未知、重复、停用或结构不兼容的类型返回 422。创建时冻结规则版本、问题类型 ID、是否请求打断及必要显示名。

`DELEGATE_OPERATED` 下，普通 member 的席位由活动 assignment 推导，且不能提交 `onBehalfOfSeatId`。Chair 可以选择任意活动席位代录。`CHAIR_OPERATED` 下只有 Chair 可以创建，并必须选择活动席位。Chair 代办保存实际 `actor_user_id` 与 `on_behalf_of_seat_id`。

回应请求为：

```json
{
  "baseRevision": 1,
  "status": "RESOLVED",
  "chairResponse": "请秘书处调整会场温度。",
  "attendanceChange": {"type": "TEMPORARILY_LEFT"}
}
```

状态只接受 `UPHELD`、`OVERRULED`、`ANSWERED`、`RESOLVED` 和 `REJECTED`。只有 `PENDING` 问题可回应；再次回应返回 409。可选出席变化只允许规则类型为个人特权问题，且在问题、attendance event、当前出席状态、委员会事件和审计的同一事务中提交；attendance event 使用 `source_point_id` 关联，不修改点名历史。

### 阶段 4 快照 audience

`GET /api/v1/committees/:id/snapshot` 返回 `schemaVersion: 2`。所有受众都可见委员会公开资料、活动席位与国旗、当前会期的非敏感摘要、当前出席状态和已公开的问题状态。member 还可见完整进行中点名、未删除笔记和文本帖子；Chair 与 Owner 另见阶段 3 的 membership、Chair 和 assignment 管理字段。

PUBLIC 匿名快照不返回 membership、assignment、用户 ID、actor、capability、笔记、帖子、问题正文、主席内部回应或审计。PRIVATE 委员会的未授权快照及其 note、post、roll call 或 point 子资源统一返回 404，不泄露对象是否存在。

跨页面和跨浏览器一致性在阶段 4 通过重新读取快照、窗口重新聚焦时 revalidation、显式刷新和 409 后重新读取实现。本阶段不开放 `/events`、`Last-Event-ID`、心跳、轮询模拟实时或事件驱动 React store。

## 11.3 阶段 5 高并发命令契约

阶段 5 在阶段 4 安全边界上增加受众过滤 SSE 和显式议事命令。`ACTIVE` 委员会允许命令，`PAUSED`、`ARCHIVED` 与 `DELETING` 拒绝议事写入。actor 始终由 Session 推导；Chair 代办只接受 `onBehalfOfSeatId`，并同时保存真实 actor。每个成功写命令在一个 PostgreSQL 事务中提交状态、委员会事件和审计。

计时器只保存 `running`、`started_at`、`remaining_at_start_ms`、到期和 revision，不写每秒 tick。发言名单行锁串行化重排和切换，数据库唯一索引限制一个当前发言人。动议、ballot 和文档使用显式状态机；ballot 创建时冻结资格、门槛、must-vote、否决席位和规则版本，一席一票由数据库唯一约束保证。

匿名意向性投票把重复投票 receipt 与选项 selection 分表保存；selection 不含 actor、席位、凭证或时间，快照、事件和审计不暴露投票人与选项关联。决议草案和修正案正文采用追加版本；进入表决时固定 `voting_version_id`，数据库触发器拒绝静默替换。本阶段没有文件 provider、上传或 Local Agent。

## 11.4 阶段 6.2 durable upload 契约

阶段 6.2 增加上传记录与持久暂存，不发布逻辑文件：

```text
POST /api/v1/committees/:id/file-uploads
PUT  /api/v1/file-uploads/:id/content
```

创建请求为：

```json
{
  "logicalName": "工作文件一",
  "originalName": "working-paper-1.pdf",
  "mediaType": "application/pdf",
  "expectedSizeBytes": 1024,
  "sha256": "64 位十六进制 SHA-256"
}
```

两条路由都要求 Session、允许的 Origin、匹配的 CSRF token 和 `Idempotency-Key`。调用者必须是 Committee Owner、Chair 或活动 member；服务端从 Session 推导 actor。`PAUSED`、`ARCHIVED` 与 `DELETING` 委员会拒绝创建上传和把内容完成为 `STAGED`。

创建响应返回 upload ID、活动 binding、元数据、预期大小与 SHA-256、状态、revision 和期限，不返回内部 `staging_key`。内容路由接收原始 HTTP 请求体，可使用 `Content-Length` 或 chunked 传输；服务端逐块执行请求上限、单文件上限、实际大小和 SHA-256 校验，不先把完整文件读入内存。

状态只按以下方向推进：

```text
CREATED → RECEIVING → STAGED
                    ↘ FAILED
STAGED → COMMITTED        # 阶段 6.3 以后
任一允许状态 → CANCELLED  # 后续阶段
```

暂存键由服务器 UUID 派生，用户文件名只保存为元数据。内部路径拒绝绝对路径、`.`、`..`、反斜杠、符号链接逃逸和非普通文件；临时文件完成 `fsync` 后才原子链接到最终暂存键。成功状态、事件、审计和内容幂等响应在同一 PostgreSQL 事务提交。若最终数据库事务失败，完整暂存文件保留，upload 停在 `RECEIVING`，相同幂等键可在恢复后重新校验并完成。

`STAGED` 只表示服务器持久暂存区已保存并校验完整字节。阶段 6.2 不调用 `recordProviderCommit`，因此不创建 `file_entry`、`file_blob`、`file_version` 或下载记录。普通期限和 LRU 不得删除 `CREATED`、`RECEIVING` 或 `STAGED`；后续清理只可选择 `COMMITTED`、`CANCELLED` 或已经过期的 `FAILED`。

## 11.5 阶段 6.3 SERVER_VOLUME 提交契约

```text
POST /api/v1/file-uploads/:id/commit
```

请求体固定为 `{}`，并继续要求 Session、允许的 Origin、匹配的 CSRF token 和 `Idempotency-Key`。只有 upload 创建者可以提交；服务端重新锁定 upload 与委员会，要求委员会为 `ACTIVE`、upload 为完整的 `STAGED`，且其 binding 仍是委员会活动的 `SERVER_VOLUME` binding。

服务端为 upload 分配一次性的 blob UUID，并只用该 UUID 派生 `blobs/<两位分片>/<压缩 UUID>`。用户文件名、逻辑名称和媒体类型不参与磁盘路径。暂存内容流式复制到 0600 临时文件；复制过程重新校验大小和 SHA-256，执行文件 `fsync` 后以无覆盖硬链接原子发布，随后同步目录并从最终文件重读校验。路径检查拒绝绝对路径、点路径、反斜杠、符号链接、硬链接和非普通文件。

provider 最终内容校验成功后，单一 PostgreSQL 事务把 upload 更新为 `COMMITTED`，并创建 `file_blob`、`file_entry`、首个 `file_version`、委员会事件、审计及幂等响应。upload 保存已提交的 blob、entry 和 version ID。数据库失败不会删除暂存或已经完整发布的 provider 字节；重试复用原 blob UUID 和存储键，不产生第二个 blob 或版本。provider 写入或完整性校验失败同样不发布数据库文件记录。

阶段 6.3 只提供校验后读取的内部原语，尚未开放下载 HTTP。已提交的服务器卷内容不属于暂存期限或 LRU 清理范围；S3、provider 切换、审核 UI 和清理 worker 留给后续阶段。

## 11.6 阶段 6.4 S3 compatible provider 契约

```text
GET  /api/v1/storage-provider-configs/s3
POST /api/v1/admin/storage-provider-configs/s3
PUT  /api/v1/admin/storage-provider-configs/:id
POST /api/v1/admin/storage-provider-configs/:id/verify
GET  /api/v1/committees/:id/storage-bindings
POST /api/v1/committees/:id/storage-bindings/server-volume
POST /api/v1/committees/:id/storage-bindings/s3
POST /api/v1/file-uploads/:id/commit
```

系统管理员创建、更新、停用和验证实例级 S3 配置。写请求继续执行 Session、Origin、CSRF、幂等键或 revision 边界。配置响应只返回显示名、endpoint、region、bucket、prefix、寻址方式、私网许可、状态和凭据 key version，不返回 access key、secret 或密文。

凭据以实例显式 `QUORUM_STORAGE_MASTER_KEY` 做 AES-256-GCM 认证加密，AAD 绑定配置 ID 与 key version。缺少 master key、版本不匹配、密文篡改或错误 key 均返回稳定的 `SERVICE_NOT_READY`，不尝试明文或默认凭据链。Chair 或 Owner 只能读取本委员会 binding 并把委员会绑定到活动配置；不能读取凭据或提交任意 endpoint。`SYSTEM_ADMIN` 不自动获得委员会 binding 权限。

endpoint 只接受无 URL 凭据、query 或 fragment 的 HTTPS URL。保存时拒绝明显的回环、链路本地、私网和元数据 IP；每次请求 DNS 解析后再次校验所有地址，并把 TLS 主机名连接固定到已校验地址，防止 DNS rebinding。私网对象存储只有系统管理员保存的 `allowPrivateNetwork` 可显式放行。

S3 object key 固定为 `<prefix>/blobs/<两位分片>/<压缩 blob UUID>`。服务端以 SigV4 从 durable staging 流式 PUT，不加载完整文件；成功响应后必须 GET 远端对象并重新计算实际大小和 SHA-256。只有远端校验成功才复用阶段 6.3 的 upload、blob、file entry/version、事件、审计和幂等事务。网络、远端状态、短写、超限或哈希失败不产生文件版本；数据库失败保留暂存与远端完整对象，同一 upload 重试复用原 blob/object key。

阶段 6.4 仅实现内部读取、验证和删除原语，不开放下载或运行物理删除任务。provider 切换、审核发布和清理留给后续阶段。

## 11.7 阶段 6.5 审核、发布、下载和永久删除契约

```text
GET    /api/v1/committees/:id/files
GET    /api/v1/files/:id
GET    /api/v1/files/:id/download
POST   /api/v1/files/:id/submit-review
POST   /api/v1/files/:id/publish
DELETE /api/v1/files/:id
```

文件状态由数据库约束为 `UPLOAD_COMPLETE → PENDING_REVIEW → PUBLISHED`；任一未删除状态可以进入 `DELETED`。新不可变版本把原文件重置为 `UPLOAD_COMPLETE` 并清除旧审核时间，已删除文件不能追加版本或复活。上传者、Chair 或 Owner 可以提交审核；只有 Chair 或 Owner 可以发布。写请求体为 `{baseRevision}`，继续要求 Session、允许的 Origin、匹配的 CSRF token 和 `Idempotency-Key`；相同 key 和请求返回原响应，不同请求复用 key 返回 `IDEMPOTENCY_CONFLICT`。委员会不是 `ACTIVE` 时拒绝提交审核、发布和删除。

公开委员会的匿名或非 member 调用者只能列出、读取和下载 `PUBLISHED` 文件；未发布文件与私有委员会统一返回 `NOT_FOUND`，避免泄漏存在性。活动 member、Chair 和 Owner 可读取本委员会所有未删除文件。系统管理员不因实例角色获得委员会文件权限。

下载以当前不可变版本记录的 binding、storage key、大小和 SHA-256 选择 provider；即使 S3 配置后来停用，已有 blob 仍使用其保存的配置读取。服务端在发送 200 响应头前完成 provider 完整性预检。响应始终使用安全编码的 `Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、限制性 CSP、same-origin CORP 和 `private, no-store`；HTML、XML、JavaScript、XHTML 与 SVG 强制返回 `application/octet-stream`，用户文件名不能注入响应头。

逻辑删除在一个 PostgreSQL 幂等事务中清除当前版本、增加 revision、追加不含内容的墓碑、把所有版本 blob 标为 `DELETE_PENDING`、为每个 blob 创建唯一 `file_blob_delete_job`，并写入事件和审计；事务失败时全部回滚。文件随后立即从列表、详情和下载消失。worker 原语使用 `FOR UPDATE SKIP LOCKED` 一次 claim 一个任务，在记录该 blob 的原 provider 上执行幂等删除；成功后原子标记 job `COMPLETED` 和 blob `DELETED`，失败保存稳定 failure code 并指数退避。进程崩溃遗留超过五分钟的 `IN_PROGRESS` claim 可重新领取；不存在的 provider 对象视为成功。阶段 6.7 已启动常驻 maintenance worker，并把成功、provider 失败和数据库完成失败写入追加式维护审计。

## 11.8 阶段 6.6 provider 切换与失败回退契约

```text
GET  /api/v1/committees/:id/storage-migrations
POST /api/v1/committees/:id/storage-migrations
POST /api/v1/storage-migrations/:id/retry
POST /api/v1/storage-migrations/:id/confirm
POST /api/v1/storage-migrations/:id/cancel
```

Owner 或 Chair 以 `{baseRevision,targetProviderType,targetProviderConfigId?}` 创建切换；写命令继续要求 Session、允许的 Origin、匹配的 CSRF token、`Idempotency-Key` 和 revision。`SYSTEM_ADMIN` 不自动获得委员会权限。目标 binding 先进入 `MIGRATING`，源 binding 与 `committees.active_storage_binding_id` 保持 `ACTIVE`。S3 目标必须为活动配置，且系统管理员对当前配置 revision 完成 HEAD 验证；配置修改会清除验证状态。

`storage_migrations` 冻结 `file_manifest_revision`，`storage_migration_items` 为每个未删除文件的所有不可变历史版本内容建立一个服务器生成的 target blob ID 和 durable staging key。后台 worker 从源 binding 解析原始或先前验证的副本，先校验源大小/SHA-256并逐块写入 durable staging，再提交目标 provider 和重读校验；用户文件名不参与路径。claim token 防止超时旧 worker 覆盖新 claim，五分钟 stale claim 可回收；失败保存稳定 code 并退避。目标副本以 `file_blob_copies(content_blob_id,storage_binding_id)` 关联，`file_versions.blob_id` 不改写。

新版本或逻辑删除递增 manifest revision，并把进行中或待确认的 migration 标为 `FAILED/MANIFEST_CHANGED`。`retry` 重新快照：补充缺失内容，取消已删除内容的 item，并复用已完成目标副本。所有 item 完成且 manifest 未变时进入 `READY_TO_CONFIRM`。`confirm` 再次读取并校验全部目标副本，然后在一个 PostgreSQL 幂等事务中锁定委员会、migration 和两个 binding，重新检查 manifest/配置/副本集合，同时把源 binding 设为 `RETIRED`、目标设为 `ACTIVE`、更新活动 binding、完成 migration，并写事件和审计。任一失败都不改变活动源。

`cancel` 保持源 binding 有效，把目标 binding 退役；已落地目标副本和取消后晚到的 provider 成功写入都标为 `DELETE_PENDING` 并进入阶段 6.5 的 durable delete job。源内容和墓碑不删除。完成切换后保留退休源副本作为安全冗余；其容量策略属于阶段 6.7，不在确认事务中冒险删除。

## 11.9 阶段 6.7 容量保护、后台清理与指标契约

```text
GET /health/ready
GET /metrics
```

应用对实际 `QUORUM_STORAGE_PATH` 执行 `statfs`。默认使用率达到 80% 为 `warning`，达到 90% 为 `critical`；阈值必须是 warning 小于 critical 的整数百分比。`critical` 阻止新 upload 创建、新内容写入和 provider migration copy，但不阻止下载、议事命令、provider delete 或 staging cleanup。已有幂等响应仍可重放，容量拒绝不能把 `CREATED` upload 提前改为 `RECEIVING`。容量采样失败、可用字节为零或必要目录不可读写时 readiness 返回统一 503；仍有可用空间的 warning/critical 会在 200 响应的 storage check 中明确报告，避免编排器因保护性写入限制反复重启仍可读实例。

`file_uploads` 和 `storage_migration_items` 分别保存 cleanup attempts、next attempt、claim token、claim time、失败摘要与 `staging_deleted_at`。maintenance worker 先运行 durable blob delete job，再用 `FOR UPDATE SKIP LOCKED` claim 一个 staging 候选；超过五分钟的 claim 可回收，旧 token 完成不会覆盖新 claim。文件系统删除发生在事务外；若进程在 unlink 后终止，重试把“文件不存在”作为幂等成功，再原子写完成状态与 `storage_cleanup_audit`。

upload 只有 `COMMITTED`、`CANCELLED`，或期限已过的 `FAILED` 可清理；`CREATED`、`RECEIVING` 和 `STAGED` 永不因普通期限、LRU 或容量压力删除。migration item 只有 `COMPLETED` 或 `CANCELLED` 可清理；活动 claim、`PENDING`、`IN_PROGRESS`、`RETRY` 和仍需恢复的失败 copy 保留。退休源 provider 副本仍是明确的安全冗余，本阶段不因压力自动删除。

`/metrics` 使用 Prometheus text exposition，只包含容量采样成功、使用率、可用字节、固定状态、三类 cleanup queue 深度和按固定 kind/outcome 聚合的维护计数。响应与结构化容量/清理日志不得包含 storage path、文件名、正文、Session 或 provider 凭据。

## 11.10 阶段 6.8 浏览器文件契约

自托管 `FilesPanel` 只调用本节 11.4–11.9 的同源接口。选择文件后，浏览器用固定 1 MiB `Blob.slice()` 分块计算 SHA-256，每次只保留当前分块；随后创建 upload，并由带 Cookie、CSRF 和调用方固定 `Idempotency-Key` 的 XHR 直接发送原始 `File`。XHR 的实际字节事件驱动上传进度，`AbortSignal` 可取消哈希或内容发送；provider 失败保留已选择文件，以新 upload 重新尝试。浏览器不把完整文件读入额外 `ArrayBuffer`，也不把凭据或文件内容写入日志。

文件列表以服务端结果为权威。PUBLIC 不显示上传或状态命令，且只会收到公开委员会的 `PUBLISHED` 文件；member 可上传，并仅对自己的文件显示提交审核和永久删除；Chair/Owner 可审核、发布、删除和管理存储。`SYSTEM_ADMIN` 身份本身不产生这些委员会操作。409、容量、provider、暂停和权限错误显示稳定短文案并重新读取列表、binding、迁移或快照，不在客户端合并陈旧 revision。

下载控件只指向 `GET /api/v1/files/:id/download`，依赖服务端 attachment 与安全类型头。浏览器不创建用户文件的 iframe、object、embed、data URL 或同源预览。文件和 storage migration SSE 事件只触发安全刷新；未知事件、序号缺口和过期游标继续使用完整快照/列表恢复。

Chair/Owner 通过 binding 列表选择初始 `SERVER_VOLUME`/S3 storage，并查看迁移的复制、失败、待确认、完成和取消状态；可执行 retry、confirm 和 cancel。系统管理员的 `/storage` 页面可以创建、编辑、停用和验证 S3 配置。保存的 access key 与 secret 不在响应中出现，编辑表单也不回填凭据；仅在同时提供新的两项凭据时才轮换。

## 11.11 阶段 7.1 Agent 配对、身份与 lease 契约

浏览器管理接口为：

```text
GET  /api/v1/committees/:id/storage-hosts
POST /api/v1/committees/:id/storage-agent/pairing-codes
POST /api/v1/committees/:id/storage-hosts/:hostId/revoke
```

只有 Committee Owner 或明确授予的 Chair 可以调用；`SYSTEM_ADMIN` 不自动获得权限。读请求要求 Session，写请求继续要求允许的 Origin、匹配的 CSRF token 和委员会 `baseRevision`。创建配对码的 `purpose` 固定为 `INITIAL` 或 `TRANSFER`：前者要求当前没有有效 host，后者要求已有 host，并在新设备真正完成配对前保持旧 host 有效。创建新配对码会撤销同委员会尚未使用的旧码并增加委员会 revision。

配对码由 16 个随机字节编码为 `QRM-` 开头的 Crockford Base32，忽略大小写和显示分隔符后固定 26 位，有效期默认 10 分钟。数据库只保存规范化值的 SHA-256；明文只在创建响应显示一次，不写入日志、事件、审计或幂等响应。设备提交 32 字节 Ed25519 公钥的无 padding base64url 表示；阶段 7.1 先冻结设备身份，后续任务协议再使用公钥能力。

Agent 接口为：

```text
POST /api/v1/storage-agent/pair
POST /api/v1/storage-agent/heartbeat
```

`pair` 请求体固定为 `{pairingCode,deviceLabel,devicePublicKey}`，不接受或依赖浏览器 Session。服务端重新锁定配对码、委员会和当前 host，并确认签发配对码的 Owner/Chair 仍有权限。成功后配对码原子标为已用，服务端签发 `qsa1.<device UUID>.<32 随机字节 base64url>` 凭据；数据库只保存完整 token 的 SHA-256。明文凭据只在配对响应显示一次。

除配对外，Agent 通过 `Authorization: QuorumAgent <credential>` 认证，不使用 Session Cookie、CSRF 或浏览器 Bearer token。凭据只解析到一个委员会和一个设备，不能授权账号或议事路由。每个 Agent 写请求必须包含正整数 `leaseGeneration`；heartbeat 请求体固定为 `{leaseGeneration}`。

`committees.storage_lease_generation` 是单调 fencing counter。首次配对、成功转移和撤销都在委员会行锁事务中递增 generation。每个委员会的 `ACTIVE`/`DEGRADED` host 由部分唯一索引限制为一个；转移事务同时撤销旧 host、创建新 host、消费配对码、写事件和审计。旧凭据、撤销设备、迟到 generation 和旧任务完成统一返回 `409 STALE_STORAGE_LEASE`，不能改变 host、文件、task 或 manifest。

heartbeat 只刷新固定 host 状态与 `last_seen_at`。默认 45 秒未见心跳的 `ACTIVE` host 由常驻 monitor 改为 `DEGRADED` 并追加 Chair 事件；委员会状态不改变，议事不暂停。有效 heartbeat 可把同一 generation 的 `DEGRADED` host 恢复为 `ACTIVE`。阶段 7.1 尚未增加 Agent task、manifest、内容传输、本地路径或 provider binding。

## 11.12 阶段 7.2 Agent task、manifest 与内容边界

migration 21 增加 `storage_manifest_events` 和 `storage_agent_tasks`，并安全替换 provider enum 以预留 `CHAIR_AGENT`；本阶段尚无创建或激活该 binding 的命令。每个委员会分别保存单调的 manifest sequence 和 task sequence。`file_versions`、`file_tombstones` 的数据库触发器在原文件事务中追加 `UPSERT` 或 `DELETE` manifest；如果当前有 `ACTIVE`/`DEGRADED` host，同一事务再创建绑定该 host 和 lease generation 的 `STORE_BLOB` 或 `DELETE_FILE` task。首次配对或主机转移会读取每个文件最新的 manifest 事件，为新 host 建立完整任务集；旧 host 的任务不迁移 generation，也不能由新 host 领取。

阶段 7.2 Agent 接口为：

```text
GET  /api/v1/storage-agent/manifest?after=:sequence&limit=:limit
GET  /api/v1/storage-agent/tasks?after=:sequence&limit=:limit
POST /api/v1/storage-agent/tasks/:id/claim
POST /api/v1/storage-agent/tasks/:id/complete
POST /api/v1/storage-agent/tasks/:id/fail
GET  /api/v1/storage-agent/blobs/:blobId
POST /api/v1/storage-agent/blobs
```

GET 请求通过 `X-Storage-Lease-Generation` 携带 generation；task 写请求体固定携带 `leaseGeneration`、`fileRevision`、UUID request ID，完成/失败另携带 claim token。领取把 `PENDING`/到期 `RETRY` 或超过五分钟的旧 claim 原子改为 `IN_PROGRESS`；相同 request ID 精确重放相同 token。terminal request ID 与 outcome 固定完成结果：同一完成/失败可重放，不同 outcome 返回 `IDEMPOTENCY_CONFLICT`。每次事务先锁委员会、再复核设备 credential、host、委员会 generation 和 task generation；转移、撤销或迟到提交返回 `STALE_STORAGE_LEASE`。

`GET blobs/:id` 只允许持有匹配 `STORE_BLOB` claim 的 Agent 读取该 task 固定的 blob，并在发送正文前从原 provider 复验大小和 SHA-256。`POST blobs` 只允许匹配 `UPLOAD_BLOB` claim，以 task ID、claim token、file revision、generation 和 SHA-256 header 约束原始 HTTP 流；服务端使用 task 派生的内部 staging key，逐块执行容量、Content-Length、实际大小和 SHA-256 校验。流式网络 I/O 在短 claim 事务之外执行，完成时重新取得当前 lease 并复核 claim；旧 host 即使已传完字节也不能在转移后提交 task 状态。只有完整内容进入 `STAGED` 后 `UPLOAD_BLOB` task 才允许完成，断流、短写、长写、超限、哈希或磁盘失败进入 `RETRY` 且不产生文件版本。

阶段 7.2 只建立服务器协议原语；生产路径尚不创建 `UPLOAD_BLOB` task，也未开放 `local-changes`。`CHAIR_AGENT` binding、离线浏览器上传编排、墓碑优先恢复、本地路径/冲突处理和桌面 Agent 属于 7.3 以后。

## 11.13 阶段 7.3 `CHAIR_AGENT` provider 与恢复编排

migration 22 把 `storage_bindings` 约束扩展为三种互斥目标：服务器卷无外部目标、S3 必须引用 provider config、`CHAIR_AGENT` 必须引用同委员会的 storage host。`file_entries.sync_state` 保存 `PENDING_HOST_COMMIT`、`SYNCED` 或 `OUT_OF_SYNC`；`file_uploads` 保存固定 task、host、lease generation 和 host commit 状态。`storage_agent_change_requests` 保存 Agent 的幂等本地变化，`storage_agent_conflicts` 保存不得静默覆盖的待 Chair 决策冲突。schema compatibility 为 22。

浏览器管理及上传恢复接口增加：

```text
POST /api/v1/committees/:id/storage-bindings/chair-agent
GET  /api/v1/committees/:id/file-uploads/pending-host-commit
```

初始 Chair binding 只允许 Owner 或明确 Chair 选择当前 `ACTIVE`/`DEGRADED` 且 generation 匹配的 host；委员会已有活动 binding、暂停/归档、陈旧 revision 或仅有 `SYSTEM_ADMIN` 身份均拒绝。待 host 提交列表要求 Session；Owner/Chair 可见委员会全部待提交 upload，普通 contributor 只见自己创建的项。

浏览器 upload 在服务器 durable staging 完整复验后，提交命令返回 `202 PENDING_HOST_COMMIT` 并创建固定 blob、未来 file entry ID、host/generation 和 `STORE_BLOB` task。Agent 只能用该 task 的 claim 读取对应 staging。task 完成事务再次检查当前 binding、host、generation、upload 大小和 SHA-256，随后原子创建 blob、file entry/version、manifest、事件与审计并把 upload 改为 `HOST_COMMITTED`。数据库事务失败不会留下 file version，原 task 与 staging 保持可重试状态；普通 cleanup 仍不选择 `STAGED` upload。

生产 `local-changes` 接口现为：

```text
POST /api/v1/storage-agent/local-changes
```

请求固定为 `{leaseGeneration,requestId,manifestSequence,change}`。`change` 是携带 file revision 的 `UPSERT`、`RENAME` 或 `DELETE`；`UPSERT` 另带逻辑名、原始名、媒体类型、大小和 SHA-256。服务器先复核当前 lease、活动 Chair binding、委员会可写状态和完整最新 manifest sequence，再以墓碑、当前 file revision 和同委员会名称唯一性判断。新增/修改创建服务器 UUID 派生的 `UPLOAD_BLOB` task；完整内容经 7.2 流式边界进入 `STAGED` 后，task 完成事务才发布版本。重命名和删除是显式 revision 命令；删除同时写墓碑、Agent 删除 task 和物理删除 job。

相同 host/request ID 精确重放 pending 或 completed 结果。manifest、墓碑、revision、名称或 host transfer 冲突先写入 durable change/conflict、Chair 事件和审计，再返回 `422 CHAIR_DECISION_REQUIRED` 及冲突 ID/原因；不会复活已删除文件或自动选择任一副本。

阶段 7.5 增加以下裁决路由：

```text
GET  /api/v1/committees/:id/storage-agent-conflicts
POST /api/v1/committees/:id/storage-agent-conflicts/:conflictId/resolve
GET  /api/v1/storage-agent/conflicts
```

浏览器读取和裁决只允许 Owner/Chair。浏览器 conflict 响应把 Agent 逻辑路径裁成文件名；完整相对路径只返回当前 Agent。写请求继续要求 Session、Origin、CSRF 和幂等键；body 固定携带 conflict revision、当前 lease generation、当前 file revision、裁决动作和按需逻辑名。事务锁定委员会、当前 host、conflict 和 file entry，任何陈旧状态返回 `REVISION_CONFLICT`。`KEEP_SERVER`、`ACCEPT_LOCAL` 和 `SAVE_AS_NEW` 都写入不可变裁决、Chair 事件与审计；名称先按跨平台 Agent 相对路径规则校验。墓碑或已删除文件不能通过 `ACCEPT_LOCAL` 复活，旧 host 独有内容只能丢弃。

Agent 只以当前 `QuorumAgent` 凭据和 generation 拉取已裁决 conflict。采用本地或另存流程复用本地持久 request ID；不可修改的 `storage_agent_conflict_applications` 保证一个 conflict 只应用一次。保留服务端产生关联 task；磁盘或网络故障保持已领取状态供同一 claim 重试。若文件在 Chair 决定后再次变化，旧 task 失败并把新内容上报为新 conflict。裁决 task 不能覆盖 conflict 路径和既有 tracked 路径以外的本地文件。

主机转移事务把活动 Chair binding 指向新 host，取消旧 generation 的非终态 task，为浏览器 `STORE_BLOB` 待提交 upload 重新创建新 generation task，并按每个文件最新 manifest 为新 host 补建任务。未完成的本地 `UPLOAD_BLOB` 因内容仍只在旧 host 而转成 `HOST_TRANSFERRED` 冲突。既有文件在转移时成为 `OUT_OF_SYNC`，相同 revision 的新 host task 完成后恢复 `SYNCED`。旧凭据、claim、内容上传和 local change 继续由 lease fencing 拒绝。

`CHAIR_AGENT` blob 不交给服务器 provider delete worker；当前 Agent 完成 `DELETE_FILE` 后才把对应 blob/delete job 标为完成。下载只在服务器仍保存并复验关联 upload staging 时可用；否则返回稳定 `SERVICE_NOT_READY`，浏览器从不直连 Agent。桌面文件系统 watcher、周期扫描和路径落盘已由 Agent 实现；Windows/macOS 发布包留到阶段 7.6。

### 11.16 阶段 8.1 委员会归档与一致性导出

```text
POST /api/v1/committees/:id/archive
GET  /api/v1/committees/:id/export
```

归档命令只允许 Committee Owner，并继续要求 Session、允许的 Origin、匹配的 CSRF token 和当前 committee revision。委员会进入 `ARCHIVED` 后，Owner、Chair、member 和公开访客仍可按原受众读取，但委员会资料、席位、议事、文本和文件状态均不可再修改；文件只保留授权下载。系统管理员不自动获得归档或导出权限。

导出只允许归档委员会的 Owner。服务端在 `REPEATABLE READ READ ONLY` 事务内分页查询，并以 JSON Lines 流式返回委员会资料、议事记录、不可变审计和文件 manifest；不会把完整导出装入内存。响应强制 attachment、`nosniff` 和 `no-store`。导出显式排除邀请码/匿名投票凭据哈希、Session、设备凭据、S3 密文、provider storage key、源 IP 摘要和文件正文；文件记录保留原始大小与 SHA-256，便于另行核对内容副本。流中最后的 `complete` 记录仅在全部查询成功后出现；断流或查询失败会回滚只读快照。

### 11.17 阶段 8.2 委员会永久删除

```text
DELETE /api/v1/committees/:id
```

该命令只允许 `ARCHIVED` 委员会的 Owner，并要求 Session、允许的 Origin、匹配的 CSRF token、`Idempotency-Key`、当前 `baseRevision` 和与数据库值逐字相同的 `confirmationName`。服务端不接受 actor、Owner 或删除目标路径。请求成功返回 `202` durable deletion job；事务同时把委员会改为 `DELETING`，使列表、快照、SSE 和普通写入立即不可用。

请求事务撤销未使用配对码，取消非终态 upload、provider migration 和既有 Agent task，把未删除文件写为墓碑，并为每个非删除 blob 创建物理删除 job。墓碑为当前 host 生成本次必须完成的 `DELETE_FILE` task。非活动 Chair binding 仍有内容或当前 Chair host 已撤销时返回 `SERVICE_NOT_READY`；不会先删除数据库记录再遗失 provider 清理目标。委员会名称只以 SHA-256 保存在 durable job 中。

常驻 deletion worker 使用 claim token 和五分钟 stale claim 恢复。它等待服务器卷/S3 blob delete job、upload/migration/Agent task staging，以及本次记录的 Agent 删除 task 全部完成。阻塞时写 `CLEANUP_PENDING` 并退避，不把唯一暂存副本当作普通过期数据删除。全部屏障清空后，worker 在单个 PostgreSQL 事务中删除委员会的议事、文件、成员、事件、审计和委员会级规则数据；append-only 历史只在当前 deletion job ID 与 claim token 同时匹配的事务内允许删除。任一语句失败都会回滚全部数据库清除并把 job 改为可重试；完成后委员会行不存在，只保留不含名称明文的 job 状态。

### 11.18 阶段 8.3 账号资源转移与匿名化

```text
POST /api/v1/admin/users/:id/anonymize
body: {replacementUserId, confirmationEmail}
```

该命令只允许已完成临时密码修改的 `SYSTEM_ADMIN`，并要求 Session、允许的 Origin、匹配的 CSRF token 和 `Idempotency-Key`。目标必须是已禁用的普通账号；接收方必须是另一个活动账号；确认邮箱按登录邮箱规范化后匹配。唯一系统管理员、活动或已匿名化账号、无效接收方以及仍拥有 `DELETING` 委员会的账号均返回稳定错误，且不发生部分转移。

事务锁定目标、接收方及全部所属委员会，把委员会、国家模板、委员会模板和规则包所有权转给接收方。每个委员会同时递增 revision，追加 `committee.owner_transferred` Chair 事件和 `admin.committee_owner_transferred` 审计。随后删除目标账号的凭据与全部 Session，把邮箱置空、显示名替换为“匿名账号”并设为 `ANONYMIZED`；议事、席位、事件和审计中的历史用户外键不改写。数据库约束和触发器禁止恢复匿名化身份。相同 actor/幂等键与相同 body 返回原结果，不同 body 返回 `IDEMPOTENCY_CONFLICT`。

### 11.19 阶段 8.4 保留策略

常驻 retention worker 默认每小时运行一次，并使用 transaction advisory lock 保证多个应用实例中只有一个 sweep 生效。保留期通过正整数环境变量设置：`QUORUM_RETENTION_SESSION_DAYS=30`、`QUORUM_RETENTION_IDEMPOTENCY_DAYS=30`、`QUORUM_RETENTION_SECRET_DAYS=7`、`QUORUM_RETENTION_REGISTRATION_DAYS=90`。Session 从撤销或到期时间计算；身份命令幂等结果从创建时间计算；席位邀请码与 Agent 配对码只有失效、撤销或使用后才可清理；注册申请只有终态且已决定后才可清理。业务 `idempotency_keys` 继续以每条记录自己的 `expires_at` 为准。

每个 sweep 在一个事务内删除合格记录并写 `operations_retention_runs` 聚合计数；任一 SQL 失败全部回滚，再以独立事务记录固定 `RETENTION_SWEEP_FAILED`。运行证据不可修改，指标只暴露完成/失败次数和最后运行时间。委员会事件、`audit_log`、`identity_audit_log`、Agent task、provider/delete job、deletion job 和文件墓碑不参与普通期限清理。Compose 对 app、Caddy 和 PostgreSQL 的 JSON 日志固定使用 10 MiB × 3 文件轮换，日志继续执行字段级秘密脱敏。

## 12. SSE 格式

```text
id: 9183
event: ballot.vote_recorded
data: {"committeeId":"...","resourceId":"...","resourceRevision":13}
```

事件类型使用稳定的过去式语义，例如：

```text
committee.updated
operation_mode.changed
attendance.changed
point.raised
point.resolved
speaker_request.created
speaker_list.created
speaker_queue.changed
speech.changed
speech.yielded
speech.contribution_recorded
timer.changed
timer.expired
motion.proposed
motion.decided
ballot.opened
ballot.vote_recorded
ballot.vote_corrected
ballot.result_published
strawpoll.created
strawpoll.vote_recorded
strawpoll.closed
document.created
document.version_created
document.status_changed
document.discussion_added
file.created
file.upload_created
file.upload_staged
file.upload_committed
file.upload_failed
file.sync_state_changed
file.deleted
storage_host.status_changed
rule_package.activated
committee.archived
```

客户端收到未知事件类型、序号缺口或不兼容 schema 时进入 `RESYNCING`，而不是猜测如何修改本地状态。

服务端同时接受查询参数 `after` 和标准 `Last-Event-ID` 请求头，优先使用两者中更新且仍有效的游标。响应定期发送无业务含义的心跳注释，反向代理必须禁用 SSE 响应缓冲。身份或委员会权限变化后，服务端重新鉴权并关闭不再允许的连接。
