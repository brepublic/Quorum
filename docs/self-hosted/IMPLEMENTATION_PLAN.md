# 自托管实施与验收计划

## 1. 实施策略

迁移采用纵向切片，不先搭一个长期不可用的“大后端”，也不把 Firebase 路径机械替换成 HTTP 路径。每一阶段都必须完成服务端授权、事务、前端接入和自动化验收，才迁移下一个领域。

当前没有生产数据，因此不开发 Firebase 数据导入和双写切换。迁移完成前，开发环境只能明确选择 Firebase 旧栈或 PostgreSQL 新栈，禁止一个业务动作同时写两套系统。

## 2. 建议代码布局

在不立即搬动现有 `src/` 的前提下逐步增加：

```text
server/
  src/
    modules/
      identity/
      authorization/
      committees/
      rules/
      proceedings/
      voting/
      realtime/
      storage/
      audit/
    http/
    db/
  migrations/
  tests/

packages/
  contracts/
  rule-schema/

agent/
  src/

deploy/
  compose.yaml
  Caddyfile
```

`packages/contracts` 只保存浏览器、后端和 Agent 共享的类型及 schema，不放数据库访问或 React 组件。现有前端逐页改为调用 typed client；不允许新页面直接访问 Firebase。

## 3. 阶段 0：行为基线和契约

交付：

- 冻结当前点名、GSL、动议、投票、计时器、模板和文件行为清单；
- 为本目录规格建立 schema 和示例 fixture；
- 明确当前行为与 `Quorum Default`、北京规则包的差异；
- 建立 API 错误码、事件名和审计动作注册表；
- 保留现有 Vitest/Cypress 用例作为回归基线。

验收：所有现有一次性单元测试和生产构建通过，规则 fixture 能在无服务器环境校验。

## 4. 阶段 1：后端和部署骨架

交付：

- Node.js 22 TypeScript 后端；
- PostgreSQL migration runner；
- `/health/live`、`/health/ready` 和版本接口；
- request ID、结构化日志和统一错误格式；
- Caddy + 应用 + PostgreSQL 的 Docker Compose；
- 同源 SPA fallback 和 `/api/v1` 路由；
- 本地测试数据库启动、重建和隔离脚本。

验收：

- 新 Ubuntu 主机只需环境文件和 Compose 即可启动；
- PostgreSQL 不暴露公网端口；
- migration 可从空库执行且重复启动安全；
- 2 GiB 内存基线下服务稳定启动。

## 5. 阶段 2：身份和唯一系统管理员

交付：

- 一次性 bootstrap secret；
- Argon2id 密码和 Session Cookie；
- CSRF、Origin 校验、登录限流；
- 管理员创建账号、临时密码、禁用、Session 撤销；
- 首次登录强制修改密码；
- 当前登录身份 API；
- 未来注册申请表结构但不开入口。

关键测试：

- 并发 bootstrap 只有一个成功；
- 未持有 secret 的公网访客不能抢占管理员；
- 登录后 Session 轮换；
- 密码重置和禁用立即撤销所有旧 Session；
- 普通账号不能调用账号管理接口。

## 6. 阶段 3：委员会、席位和规则包

交付：

- 委员会公开性、归属、Chair 能力和运作模式；
- 成员关系、席位、一席多代表和邀请码；
- 内置 `Quorum Default` 与北京规则包；
- 规则包导入、克隆、校验、模拟、版本和激活；
- 主席单次覆盖和委员会新版本；
- 公开/私有快照授权。

关键测试：

- 一个用户在同一委员会最多一个活动席位；
- 多名用户可以共享席位；
- Committee Owner 和 Chair 能力不混淆；
- 系统管理员不能静默执行 Chair 命令；
- 规则包任意代码、无效引用和复杂度攻击被拒绝；
- 新规则版本不改变旧 ballot 快照。

## 7. 阶段 4：低并发业务切片

优先迁移：

- 委员会资料和设置；
- 账号级委员会模板和国家模板；
- 成员与国旗快照；
- 笔记和普通文本帖子；
- 点名和出席事件；
- 问题及主席回应。

每个切片都使用显式命令、revision、事件和审计，不保留浏览器数据库引用抽象。

验收：前端对应页面不再导入 Firebase；刷新、跨浏览器同步和权限失败均由 API 契约覆盖。

## 8. 阶段 5：实时与高并发议事

迁移顺序：

1. 快照、committee event sequence 和 SSE 补偿；
2. 服务器权威计时器；
3. GSL 和有主持核心磋商队列；
4. 让渡、发言历史和主席代办；
5. 动议、附议和裁决；
6. 正式 ballot、票更正、否决权和结果发布；
7. 匿名与席位 Strawpoll；
8. 决议、修正案和讨论。

关键测试：

- 两个 Chair 同时调整同一队列仍保持顺序和唯一当前发言人；
- 一个席位的两名代表同时投票只有一个成功；
- 代表默认不能改票，Chair 更正保留完整历史；
- SSE 断线后按序补齐，游标过期后回退快照；
- 未知事件使客户端重新同步，不产生部分本地状态；
- 计时器不受客户端时钟篡改影响；
- 主席操作模式下所有代办记录实际 actor。

## 9. 阶段 6：服务器卷和 S3 文件

交付：

- 持久上传暂存、流式大小限制和 SHA-256；
- `SERVER_VOLUME` provider；
- `S3_COMPATIBLE` provider；
- 文件审核、发布、永久删除和墓碑；
- 存储 provider 切换；
- 磁盘阈值和后台清理任务。

关键测试：

- 上传未完整提交时不会出现可下载文件记录；
- Storage 失败保留暂存或元数据以便重试，不产生无内容记录；
- 路径逃逸、危险内联类型和超限上传被拒绝；
- provider 切换失败继续使用旧 provider；
- 永久删除后离线清单不能复活文件。

## 10. 阶段 7：Chair Local Agent

交付：

- Agent 配对、设备凭据和撤销；
- 单主机 lease generation 与 fencing；
- Windows x86-64 和 macOS 发布包；
- 文件系统监测加完整扫描；
- durable staging、任务重试和 manifest 校验；
- 离线警告、恢复同步和主机转移；
- Linux 构建预留。

关键测试：

- 旧主机在转移后无法提交；
- Agent 离线不暂停会议；
- 离线期间删除、修改和重命名在恢复后得到明确处理；
- 服务端下发文件先校验再原子替换；
- 断电或进程终止不会留下被误判为完整的本地文件。

## 11. 阶段 8：归档、删除与运维

交付：

- 委员会只读归档；
- 导出议事记录、审计和文件 manifest；
- 主席确认永久删除；
- 账号资源归属转移和匿名化；
- 事件、Session、任务和日志保留策略；
- 管理状态页和容量告警。

虽然首版不配置备份计划，仍需提供数据库 dump、文件 manifest 和恢复说明，确保日后增加备份不需要修改数据模型。

## 12. 阶段 9：移除 Firebase

只有当所有功能纵向切片通过验收后才执行：

- 删除 Firebase Auth、Realtime Database、Storage 和 Functions 运行时代码；
- 删除 Rules、Functions 和 emulator 编排；
- 删除 `react-firebase-hooks`、Firebase SDK 和 Firebase CLI 依赖；
- 用 PostgreSQL/API 集成测试替代 emulator seed；
- 更新 `PROJECT_ARCHITECTURE.md`，将自托管架构改为当前事实；
- 保留必要的上游项目致谢和兼容性 localStorage 键，除非另有迁移决定。

验收：仓库源码、依赖、构建产物和生产网络请求中均无 Firebase 运行依赖。

## 13. 每阶段统一完成标准

- 后端授权测试覆盖允许和拒绝路径；
- 事务并发测试覆盖重复提交、陈旧 revision 和幂等重试；
- 事件与业务状态在故障注入下不分离；
- 用户可见文案经过精简和简体中文术语检查；
- `pnpm exec vitest run`、相关集成测试、`pnpm build` 和 `git diff --check` 通过；
- 浏览器或 E2E 未运行时明确说明，不能用单元测试代替视觉或运行证据；
- `PROJECT_ARCHITECTURE.md` 只描述已经落地的当前事实，目标设计继续维护在本目录。

## 14. 首个实现里程碑

建议下一步只实施阶段 0 和阶段 1：建立共享契约、后端空骨架、PostgreSQL migration 和本地 Compose，并保持现有 Firebase 应用行为不变。第一个可演示结果应是同一域名下 SPA 正常打开、`/health/ready` 返回后端和数据库状态、空库 migration 可重建；此时还不切换登录或业务页面。
