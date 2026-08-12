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

`voting_mode` 为 `SEAT_AUTHENTICATED` 或 `ANONYMOUS`。席位模式复用一席一票语义。匿名模式使用不可猜测访问 token、poll 专用浏览器标识和限流；匿名票不保存为正式 ballot，也不能转换成正式结果。

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
POST /api/v1/seat-invitations/redeem
POST /api/v1/committees/:id/operation-mode
```

### 议事命令

```text
POST /api/v1/committees/:id/roll-calls
POST /api/v1/roll-calls/:id/record-response
POST /api/v1/committees/:id/attendance-events

POST /api/v1/committees/:id/points
POST /api/v1/points/:id/resolve

POST /api/v1/speaker-lists/:id/requests
POST /api/v1/speaker-requests/:id/approve
POST /api/v1/speaker-requests/:id/reject
POST /api/v1/speaker-lists/:id/advance
POST /api/v1/speaker-lists/:id/reorder
POST /api/v1/speaker-lists/:id/yield

POST /api/v1/committees/:id/motions
POST /api/v1/motions/:id/second
POST /api/v1/motions/:id/decide

POST /api/v1/timers/:id/start
POST /api/v1/timers/:id/pause
POST /api/v1/timers/:id/reset
POST /api/v1/timers/:id/extend

POST /api/v1/ballots/:id/open
POST /api/v1/ballots/:id/votes
POST /api/v1/ballots/:id/correct-vote
POST /api/v1/ballots/:id/close
POST /api/v1/ballots/:id/publish
POST /api/v1/ballots/:id/reopen
```

### 规则与实时

```text
GET  /api/v1/rule-packages
POST /api/v1/rule-packages/:id/clone
POST /api/v1/rule-packages/:id/versions
POST /api/v1/rule-package-versions/:id/validate
POST /api/v1/committees/:id/rules/activate

GET  /api/v1/committees/:id/events?after=:sequence
```

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
speaker_queue.changed
timer.changed
timer.expired
motion.proposed
motion.decided
ballot.opened
ballot.vote_recorded
ballot.vote_corrected
ballot.result_published
file.created
file.sync_state_changed
file.deleted
storage_host.status_changed
rule_package.activated
committee.archived
```

客户端收到未知事件类型、序号缺口或不兼容 schema 时进入 `RESYNCING`，而不是猜测如何修改本地状态。

服务端同时接受查询参数 `after` 和标准 `Last-Event-ID` 请求头，优先使用两者中更新且仍有效的游标。响应定期发送无业务含义的心跳注释，反向代理必须禁用 SSE 响应缓冲。身份或委员会权限变化后，服务端重新鉴权并关闭不再允许的连接。
