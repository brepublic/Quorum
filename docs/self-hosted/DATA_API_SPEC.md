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
