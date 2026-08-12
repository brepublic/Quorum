# `@quorum/contracts`

浏览器、Quorum 后端和未来 Chair Local Agent 共用的传输契约。这里仅包含类型、JSON Schema 和稳定注册表，不包含 React、数据库访问或服务端授权逻辑。

- `ERROR_DEFINITIONS` 是公开错误码和默认 HTTP 状态注册表。
- `COMMITTEE_EVENT_DEFINITIONS` 是 SSE 事件名注册表。
- `AUDIT_ACTION_DEFINITIONS` 是关键审计动作注册表。
- `API_*_SCHEMA` 可用于独立检查统一响应 envelope。
- `COMMAND_ENVELOPE_SCHEMA`、`COMMITTEE_EVENT_SCHEMA` 和 `AUDIT_ENTRY_SCHEMA` 固定命令、事件与审计边界。
- `stage3.ts` 固定委员会快照、席位、规则包、模拟结果和不可变规则评估快照。
- `stage4.ts` 固定账号模板、国旗与席位快照、文本资源、会期、点名、出席和问题命令。
- `fixtures/` 提供 revision 冲突、表决事件和主席更正审计示例。

新增或重命名稳定值时必须同步修改规格、消费者和兼容性测试；已经发布的名字不能就地改变语义。

契约版本 2 增加阶段 4 类型和稳定事件/审计名称。它不包含 SSE 客户端、计时器、动议、发言名单、正式表决或附件上传实现。
