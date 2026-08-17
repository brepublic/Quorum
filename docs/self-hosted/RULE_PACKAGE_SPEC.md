# 规则包规格 v0.1

## 1. 设计目标

规则包用于帮助主席团依照不同议事规则操作，而不是把某一学术标准写死成产品流程。Quorum 内置 `Quorum Default` 和 `北京学术标准`，用户可以克隆并建立足够细粒度的委员会规则版本。

规则包必须同时提供：

- 可直接使用的默认值；
- 与当前操作相关的短提示；
- 可计算的条件和门槛；
- 偏离规则时的提示等级；
- 由内置安全动作组成的效果；
- 主席覆盖方式。

## 2. 包和版本

```text
rule_packages
  id, scope, owner_user_id?, key, status

rule_package_versions
  id, package_id, version, definition, schema_version
  created_by_user_id, created_at, published_at

committee_rule_bindings
  committee_id, package_version_id, effective_from_event_sequence
```

作用域：

- `BUILTIN`：随 Quorum 发布，不可原地修改。
- `SYSTEM`：系统管理员安装并在实例内共享。
- `COMMITTEE`：Chair 从任一包克隆，只供该委员会使用。

已发布版本不可修改。编辑会创建草稿，发布后生成新版本。Chair 可把委员会包提交给系统管理员，批准后复制成系统共享包。

## 3. 有效值解析

```text
operation_override
  > committee package version
  > inherited package version
  > Quorum product default
```

所有可配置字段必须有产品默认值，或者被 schema 标记为创建委员会时必须显式选择。包缺少新增字段时自动回退，不因 Quorum 升级失效。

### 3.1 产品级回退值

当规则包和委员会版本都没有给出值时，使用以下保守回退：

| 项目 | 回退或创建时行为 |
| --- | --- |
| 规则包 | 新委员会默认选择 `Quorum Default` |
| 委员会可见性 | 创建时必须确认，界面推荐 `PRIVATE` |
| 运作模式 | `Quorum Default` 为 `DELEGATE_OPERATED`；北京包为 `CHAIR_OPERATED` |
| 存储提供者 | 创建时必须确认，界面推荐 `SERVER_VOLUME`；选择 Chair Computer 前必须完成 Agent 配对 |
| 代表改票 | `false` |
| 主席更正票 | `true`，保留原票和更正历史 |
| 匿名 Strawpoll | `false`，每次 poll 显式开启 |
| 主席覆盖学术规则 | `true` |
| 陈旧普通写入 | 返回 `409`，不自动覆盖 |
| 未识别表达式或效果 | 规则包校验失败，不在会中猜测执行 |
| 缺少用户可见名称 | 回退包的名称，再回退稳定 ID；发布校验提出警告 |

具体发言时间、附议数、门槛、让渡和议事阶段等学术默认值属于规则包本身。`Quorum Default` 在阶段 0 冻结并继承当前产品行为；北京包采用经审阅的北京学术标准参考值。包作者省略这些字段时才使用 Quorum 产品默认定义。

每一项配置可包含：

```json
{
  "defaultValue": 120,
  "guidance": {
    "en": "Suggested speaking time.",
    "zh-CN": "建议发言时间。"
  },
  "condition": {"op": "eq", "left": {"fact": "meeting.phase"}, "right": "FORMAL_DEBATE"},
  "deviationLevel": "WARNING",
  "chairOverride": true,
  "confirmation": "NONE"
}
```

## 4. 评估和裁决

规则评估结果：

| 结果 | 意义 |
| --- | --- |
| `PASS` | 符合规则 |
| `ADVISORY` | 展示建议，不改变操作 |
| `WARNING` | 明确指出偏离，Chair 可继续 |
| `CHAIR_DECISION_REQUIRED` | 代表请求等待 Chair 接受、修改或驳回 |

Chair 覆盖范围：

- `ONCE`：只对当前命令有效。
- `FUTURE`：生成新委员会规则版本，只影响未来命令。
- `CURRENT_PROCESS`：同时改变正在运行的计时器、队列或表决，必须额外确认。

普通偏离不强制填写理由。修改已公布结果、清空已有票、强制结束不可逆阶段、永久删除委员会、强制存储转移或绕过文件完整性警告时使用 `REASON_REQUIRED`。

## 5. 安全表达式

定义中不允许 JavaScript、SQL、正则回溯表达式、网络访问或动态模块。表达式是有限 JSON AST。

允许的事实命名空间示例：

```text
meeting.phase
meeting.operationMode
attendance.presentSeatCount
attendance.eligibleSeatCount
speakerList.queueLength
speakerList.remainingTimeMs
motion.type
motion.secondCount
ballot.castCount
ballot.eligibleSeatCount
documents.pendingCount
actor.capabilities
```

允许操作：

```text
and, or, not
eq, ne, gt, gte, lt, lte, in
add, subtract, multiply, divide
ceil, floor, min, max
count, sum
```

表达式有节点数、嵌套深度和执行步数上限；除以零、未知事实和类型错误会使包校验失败，不在会议中静默回退。

## 6. 内置效果

自定义规则可以组合受控效果：

```text
SET_MEETING_PHASE
CREATE_SPEAKER_LIST
CREATE_CAUCUS
ADD_PROPOSER_AS_FIRST_SPEAKER
START_TIMER
CHANGE_SPEAKER_DURATION
START_BALLOT
SET_DOCUMENT_STATUS
PAUSE_MEETING
RESUME_MEETING
RECALCULATE_THRESHOLDS
NO_STATE_CHANGE
```

效果只能调用后端已实现并独立授权的业务命令。新增完全不同的外部副作用需要 Quorum 升级或未来受信任插件，不允许通过规则 JSON 注入代码。

## 7. 可配置领域

### 7.1 出席与门槛

- 点名回答类型、顺序和重新点名建议；
- 法定出席数、简单多数、三分之二多数和自定义门槛公式；
- 临时离场与恢复出席；
- 哪些席位计入分母；
- 门槛不足时的提示和建议阶段。

### 7.2 议事阶段

- 自定义阶段、显示顺序和多语言名称；
- 每个阶段建议可用的操作；
- 进入、退出和返回条件；
- 推荐下一阶段；
- 主席始终可以显式切换。

### 7.3 发言名单和让渡

- 名单类型、默认时间、加入和重复加入规则；
- 代表申请或主席直接加入；
- 排序、当前发言者和结束建议；
- 让渡类型、最低剩余时间、是否允许再次让渡。

### 7.4 问题

规则包可以定义任意问题类型，包括名称、内容字段、优先级、能否请求打断、建议裁决和关联效果。北京包内置程序性问题、咨询性问题和个人特权问题。

### 7.5 动议

每种动议可定义字段 schema、提出时机、附议数、优先级、门槛、表决方式、通过效果和主席提示。自定义动议可组合内置效果。

### 7.6 表决

- 席位、用户或匿名投票主体；
- 资格、弃权、公开性、否决权和平票处理；
- 是否需要收齐全部票；
- 票是否允许由代表修改；
- 主席代录、更正、重开和结果公布；
- 门槛公式和计算时机。

正式 ballot 创建时冻结规则版本、资格席位集合、门槛公式和计算结果。出席或规则后来变化不会改写已公布结果；Chair 可显式重开或重新计算。

### 7.7 文件流程

- 文件类型、必填提交信息、审核和编号；
- 起草国、附议国、阅读、介绍和提问环节；
- 发布、延置、恢复和表决建议；
- 文件名规范只作提示，不作为文件系统安全边界。

### 7.8 术语和界面

规则包可改变多语言术语、表单顺序、主席快捷操作和常用时间选项。它不能隐藏安全警告、实际操作者、主席代办标记或审计入口。

## 8. 最小包结构

```json
{
  "schemaVersion": 1,
  "key": "builtin:quorum-default",
  "metadata": {
    "defaultLanguage": "zh-CN",
    "names": {
      "zh-CN": "Quorum 默认规则",
      "en": "Quorum Default"
    }
  },
  "meeting": {},
  "attendance": {},
  "phases": [],
  "speakerLists": [],
  "points": [],
  "motions": [],
  "ballots": {},
  "documents": {},
  "terminology": {}
}
```

导入器拒绝未知顶层字段、重复稳定 ID、无效引用、表达式类型错误和循环继承。安装前提供模拟器，用给定席位数、出席数和投票分布展示门槛与效果，Chair 确认后才能发布。

## 9. 阶段 3 已实现边界

阶段 3 在 `packages/rule-schema` 实现无服务器校验、有限表达式求值、模拟和有效值解析。运行时只接受注册事实与操作符，并限制表达式节点、嵌套深度和执行步数。校验拒绝未知顶层或可执行字段、重复稳定 ID、无效引用、未知事实、类型错误、除以零、未知效果、缺失继承和继承循环。

有效值解析顺序固定为本次 Chair 覆盖、委员会版本、继承包版本、产品默认定义。调用方必须提供产品默认值；缺失时返回错误，不在会议中猜测。

PostgreSQL 保存 `BUILTIN`、`SYSTEM` 和 `COMMITTEE` 包，以及草稿和已发布版本。应用启动时幂等安装 `Quorum Default` 与 `北京学术标准`。数据库触发器禁止更新或删除已发布版本；`BUILTIN` 包不接受新版本。`SYSTEM_ADMIN` 只能管理 `SYSTEM` 包；只有有效 Chair 可以管理委员会包、激活版本或创建主席覆盖。

模拟器返回计算值和经过校验的声明式效果，不执行效果，也不写委员会状态。`ONCE` 覆盖保存操作级裁决；`FUTURE` 从当前定义创建新的委员会规则版本。新版本必须另行激活，且只影响后续命令。阶段 3 不实现 `CURRENT_PROCESS`。

`packages/contracts` 的 `FrozenRuleEvaluation` 保存规则版本 ID、定义、事实和解析值的深拷贝。以后创建 ballot 时必须保存该结构；激活新版本不会修改既有快照。阶段 3 只建立此契约，不创建 ballot 表或投票 API。
