# 模糊错误提示只读检查报告

日期：2026-09-20

工作区备注：检查结束时发现主席 Agent/桌面端文件出现并行修改（`desktop-bridge.ts`、`localization.rs`、`main.rs`、`main.slint`），本任务未修改这些文件。相关只读结论基于检查时读取的版本，后续处理前应重新核对。

## 范围与结论

按要求仅修复“重复加入发言名单”的提示；以下其他发现均未修改。检查覆盖浏览器、服务端、共享契约、Node 主席 Agent、Rust/Slint 桌面端及脚本的错误处理入口。对 `src/`、`server/`、`packages/`、`scripts/` 中 130 个非测试 TypeScript/JavaScript 文件进行了静态扫描，另外检查了桌面端错误映射。未扫描依赖、生成产物，未逐个运行所有错误分支。

通过 TypeScript 语法树枚举到 821 处对象参数形式的 `new AppError(...)`，790 处未显式指定 `reason`。这些是代码位置数量，不是 790 个已确认缺陷：资源不存在、权限保护、版本冲突等场景可能适合通用文案；后台任务和仅供 Agent 使用的接口也不能直接等同于网页错误。

## 本次已修复

- 服务端：`server/src/modules/stage5/service.ts:755`，重复入队返回 `SPEAKER_ALREADY_QUEUED` 具体原因，保留原有 `RESOURCE_CONFLICT`、HTTP 409 和重复检查逻辑。
- 文案：`packages/contracts/src/error-localization.ts:21`。
  - 中文：**该席位已在发言名单中，不能重复加入。**
  - 英文：**This seat is already on the speaker list and cannot be added again.**
- 原检查覆盖等待发言和正在发言的席位（`QUEUED` / `CURRENT`），这两种状态共享明确提示。主发言名单与有主持核心磋商共用同一接口。

验证：

- 浏览器在用户给定页面重复添加 Bahrain，修复前显示“当前状态不允许此操作。”；修复后显示新的完整中文提示，队列仍只有原条目。
- 现有错误本地化、API 客户端、Stage 5 HTTP 测试共 38 项通过。
- 共享契约构建、前端类型检查、服务端构建通过。
- 本机 `quorum-dev` 的 app 已重建并启动，健康状态为 healthy；镜像中的完整 `build:self-host` 构建通过。
- 未运行全仓测试或单独的 PostgreSQL 集成测试；浏览器验收走的是实际开发后端。英文文案通过编译，未切换语言进行浏览器验收。

## 已确认的其他问题（仅报告）

### 1. 具体业务原因被通用错误覆盖

`server/src/http/errors.ts:28` 在没有 `reason` 时直接采用大类错误码；`packages/contracts/src/error-localization.ts:59` 起的格式化函数只读取已登记的原因或错误码，不显示原始 `message`。`src/services/self-hosted-api.ts:90` 保留结构化错误，工作区再通过 `apiErrorText` 展示。因此，下列分支虽然服务端消息具体，但到网页会丢失操作所需信息。

| 场景与位置 | 实际被隐藏的原因 | 当前提示 | 建议方向 |
| --- | --- | --- | --- |
| 发言，`server/src/modules/stage5/service.ts:734` | 名单已关闭 | 当前状态不允许此操作。 | 请先开放发言名单 |
| 发言，`server/src/modules/stage5/service.ts:930`、934 | 须先暂停或完成当前发言才能切换下一位 | 同上 | 按具体阻挡条件分别提示 |
| 计时器，`server/src/modules/stage5/service.ts:497` | 时间已耗尽，须重置或延长后启动 | 同上 | 提示重置或延长计时器 |
| 点名，`server/src/modules/stage4/service.ts:1510`、1543、1687 | 没有活动席位、须先记录当前席位、没有可撤销的记录 | 同上 | 分别给出原因 |
| 动议，`server/src/modules/stage5/service.ts:2005` | 附议数量未满足要求 | 同上 | 提示附议不足 |
| 决议/修正案，`server/src/modules/stage5/service.ts:1831`、1882、1884 | 附件未发布或内容为空 | 同上 | 提示补正文/附件或先发布附件 |
| 表决，`server/src/modules/stage5/service.ts:2449`、2471 | 必须投票的席位尚未全部投票、发布前尚未结束表决 | 同上 | 明确下一步 |
| 席位分配，`server/src/modules/stage3/service.ts:636` | 账号已有活动席位 | 同上 | 明确重复分配 |
| 代表文件，`server/src/modules/delegate-files/service.ts:156` | 尚未开始首个会期 | 同上 | 请先开始会期 |
| 导出/删除，`server/src/modules/operations/archive-service.ts:96`、`deletion-service.ts:145` | 委员会尚未归档 | 同上 | 提示先归档 |
| 入队资格，`server/src/modules/stage5/service.ts:752` | 只有当前出席的活动席位可以入队 | 请检查输入内容后重试。 | 明确出席要求 |
| 缓存，`server/src/modules/storage/cache-service.ts:57`、71、82 | 缓存/待审核空间已满或保留空间不足 | 服务暂不可用，请稍后重试。 | 说明空间不足，避免无效重试 |

这里确认的是错误分支到共享格式化函数的信息丢失，不代表每个分支都能在当前界面的正常操作中直接触发；部分按钮已有禁用条件，但并发或状态变化仍可能到达服务端分支。

### 2. 字段被标出，但没有说明如何修正

`server/src/modules/stage4/validation.ts:16` 和 `server/src/modules/delegate-files/settings.ts:4` 的公共校验入口统一使用 `INVALID_FIELD`，会显示“请检查标记的字段。”。例如名字过长/为空、旗帜不是有效 WebP、设置内容不合法等不同原因被合并。`src/components/useApiFieldErrors.ts:19` 可以定位字段，但无法恢复校验条件。

建议对用户实际能修正的长度、格式、必填要求补具体原因和必要参数；不要把内部字段名或原始异常直接显示出来。

### 3. 普通业务请求与代表入口丢失网络/响应错误分类

`src/services/self-hosted-api.ts:84`、144 附近的两个请求函数直接 `fetch` 并 `response.json()`。断网抛出的普通异常、非 JSON 错误页和空响应都会绕过结构化错误，最终通常变成“请求失败，请稍后重试。”；不能区分连接失败与服务器响应异常。

身份客户端 `src/services/self-hosted-identity.ts:88`、94、105 已做相应分类，可以作为现有模式参考。建议只修业务客户端分类，不放开原始响应内容展示。

### 4. 上传断网被显示成服务器内部错误

`src/services/self-hosted-api.ts:126`、176 的 `xhr.onerror` 都使用 `INTERNAL_ERROR`；118、168 附近的 JSON 解析失败也使用相同错误码。界面因此会显示“服务器未能完成请求，请稍后重试。”，不能表达连接中断或无效响应。

建议分别沿用已有 `NETWORK_ERROR`、`INVALID_RESPONSE` 分类，并保留上传取消的单独处理。

### 5. 下载不可用的具体原因被丢弃

`src/pages/self-hosted/FilesPanel.tsx:92` 与 `DelegateFilePortal.tsx:138` 把 `readiness.code` 放入普通 `Error.message`，而共享错误格式化不会读取该消息。

`server/src/modules/storage/cache-refill-service.ts:14`、24、26、36、62 已区分缓存容量不足、主席 Agent 离线、需要升级、源文件缺失等情况；界面却退化为“请求失败，请稍后重试。”。建议为这些已知状态提供明确、安全的文案映射，并保留结构化标识。

### 6. 主题文件过大时会出现空错误文案

`src/theme/ThemeProvider.tsx:136` 抛出带 `THEME_TOO_LARGE` 错误码但没有 message 的 `new Error()`；141–142 的 catch 只读取 `error.message` 并传入 `t`。因此错误码虽有翻译，实际呈现的错误正文仍为空。这比通用提示更严重。

建议让已知结构化错误走已有格式化入口，同时保留主题校验现有的可读错误说明。此项是静态确认，未开启主题功能或导入文件复现。

## 待进一步核实

- 主席桌面端：`packages/storage-agent/src/errors.ts:20` 起只传固定错误码，未读取 `AgentApiError.localization.reason`。`packages/storage-agent-desktop/src/localization.rs:125`、214 将整个 `RESOURCE_CONFLICT` / `VALIDATION_FAILED` 类别解释为配对问题。配对时可能合理，但其他操作收到这些码时可能给出错误建议；需在真实配对、解除配对和同步失败场景进一步确认。本次未进行原生 Agent 验收。
- 有些数据库唯一约束冲突在 `server/src/modules/stage4/database.ts:45` 和 `stage3/service.ts:160` 已被合并为“大类资源冲突”，需要结合约束与用户操作区分，不能仅替换一条文案就假定全部明确。

## 不应一律修改的情况

未知内部异常继续使用通用错误，避免显示路径、数据库内容或响应正文；隐藏无权访问资源的“未找到”提示应维持安全边界。版本冲突已有“状态已更新，请重新载入后重试。”，通常足够明确。应优先补可由用户纠正的业务原因，而不是批量展示服务端原始消息。

## 扫描统计与候选清单

下表是未显式指定 `reason` 的静态数量。大类本身已有明确意义的记录不一定需要修复。动态错误码单独列出；不将其当成确定问题。

| 错误码/表达式 | 位置数 |
| --- | ---: |
| `AUTHENTICATION_REQUIRED` | 18 |
| `BAD_REQUEST` | 14 |
| `CHAIR_DECISION_REQUIRED` | 1 |
| `CURSOR_EXPIRED` | 1 |
| `FORBIDDEN` | 87 |
| `IDEMPOTENCY_CONFLICT` | 8 |
| `INTERNAL_ERROR` | 11 |
| `LINK_EXPIRED` | 5 |
| `METHOD_NOT_ALLOWED` | 1 |
| `NOT_FOUND` | 132 |
| `PAYLOAD_TOO_LARGE` | 3 |
| `RATE_LIMITED` | 2 |
| `RESOURCE_CONFLICT` | 174 |
| `REVISION_CONFLICT` | 68 |
| `SERVICE_NOT_READY` | 29 |
| `STALE_STORAGE_LEASE` | 8 |
| `VALIDATION_FAILED` | 222 |
| `attempt.code ?? 'INTERNAL_ERROR'` | 1 |
| `error.apiCode` | 5 |

### 业务冲突、校验与权限候选位置

以下列出 `RESOURCE_CONFLICT`、`VALIDATION_FAILED`、`BAD_REQUEST`、`FORBIDDEN`、`CHAIR_DECISION_REQUIRED` 未指定具体原因的全部位置，便于后续逐项筛选；并非逐条建议修改，也不是浏览器复现清单。原始 message 仅作代码证据。行号基于本次修复后的工作区。

#### `server/src/http/app.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 122 | `BAD_REQUEST` | Request body must be a JSON object. |
| 130 | `BAD_REQUEST` | \`Field ${name} must be a string.\` |
| 141 | `BAD_REQUEST` | Idempotency-Key is required. |
| 148 | `FORBIDDEN` | Request origin is not allowed. |
| 195 | `BAD_REQUEST` | \`Field ${name} must be a positive integer.\` |
| 204 | `BAD_REQUEST` | Content-Length is invalid. |
| 234 | `BAD_REQUEST` | \`Header ${name} must be a positive integer.\` |
| 241 | `BAD_REQUEST` | \`Header ${name} is required.\` |
| 765 | `RESOURCE_CONFLICT` | This browser has already selected a delegation. |

#### `server/src/http/cookies.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 43 | `FORBIDDEN` | CSRF validation failed. |
| 48 | `FORBIDDEN` | CSRF validation failed. |

#### `server/src/modules/delegate-files/service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 48 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 54 | `VALIDATION_FAILED` | Revision is invalid. |
| 60 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 66 | `VALIDATION_FAILED` | File type is invalid. |
| 118 | `FORBIDDEN` | System administrator access is required. |
| 123 | `RESOURCE_CONFLICT` | 当前委员会状态不允许修改设置。 |
| 156 | `RESOURCE_CONFLICT` | Open the first meeting session before sharing files. |
| 207 | `RESOURCE_CONFLICT` | This delegation is not currently eligible. |
| 292 | `RESOURCE_CONFLICT` | File status does not allow approval. |
| 343 | `RESOURCE_CONFLICT` | File status does not allow rejection. |
| 346 | `VALIDATION_FAILED` | 请选择有效的驳回类型。 |
| 431 | `FORBIDDEN` | Chair or committee owner access is required. |
| 442 | `RESOURCE_CONFLICT` | Delegate file sharing is unavailable. |
| 526 | `FORBIDDEN` | This delegation is not currently eligible to upload. |

#### `server/src/modules/identity/postgres.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 126 | `RESOURCE_CONFLICT` | The instance is already initialized. |
| 129 | `FORBIDDEN` | Initialization credentials are invalid. |

#### `server/src/modules/identity/service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 199 | `VALIDATION_FAILED` | Theme settings are invalid. |
| 218 | `VALIDATION_FAILED` | Default committee behavior is invalid. |
| 291 | `BAD_REQUEST` | Idempotency-Key is required. |

#### `server/src/modules/operations/archive-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 88 | `FORBIDDEN` | Change the temporary password first. |
| 96 | `RESOURCE_CONFLICT` | Archive the committee before exporting it. |

#### `server/src/modules/operations/deletion-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 120 | `VALIDATION_FAILED` | Deletion confirmation is invalid. |
| 126 | `VALIDATION_FAILED` | Deletion confirmation is invalid. |
| 145 | `RESOURCE_CONFLICT` | Archive the committee before deleting it. |
| 152 | `VALIDATION_FAILED` | Committee name does not match. |

#### `server/src/modules/operations/status-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 20 | `FORBIDDEN` | System administrator access is required. |

#### `server/src/modules/operations/storage-cache-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 18 | `FORBIDDEN` | System administrator access is required. |
| 24 | `VALIDATION_FAILED` | \`${name} is outside the deployment boundary.\` |
| 66 | `VALIDATION_FAILED` | Storage cache configuration violates deployment boundaries. |

#### `server/src/modules/realtime/service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 42 | `BAD_REQUEST` | The event cursor is invalid. |
| 52 | `BAD_REQUEST` | The event cursor is ahead of the committee. |

#### `server/src/modules/stage3/service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 124 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 132 | `VALIDATION_FAILED` | Enter a valid email address. |
| 139 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 146 | `FORBIDDEN` | Change the temporary password first. |
| 160 | `RESOURCE_CONFLICT` | The requested active assignment or stable key already exists. |
| 163 | `VALIDATION_FAILED` | The request contains an invalid reference or value. |
| 215 | `RESOURCE_CONFLICT` | The committee is read-only. |
| 228 | `FORBIDDEN` | Chair capability is required. |
| 233 | `FORBIDDEN` | Committee owner access is required. |
| 253 | `VALIDATION_FAILED` | Rule path is invalid. |
| 260 | `VALIDATION_FAILED` | Rule path does not identify a configurable value. |
| 274 | `VALIDATION_FAILED` | Rule package is invalid. |
| 281 | `VALIDATION_FAILED` | Rule package inheritance is invalid. |
| 382 | `VALIDATION_FAILED` | Committee patch contains an unsupported field. |
| 393 | `VALIDATION_FAILED` | Committee visibility is invalid. |
| 421 | `RESOURCE_CONFLICT` | Committee deletion has already started. |
| 445 | `FORBIDDEN` | The system administrator cannot receive Chair capability. |
| 468 | `VALIDATION_FAILED` | Committee operation mode is invalid. |
| 492 | `VALIDATION_FAILED` | Motion settings are invalid. |
| 521 | `VALIDATION_FAILED` | Layout settings are invalid. |
| 544 | `VALIDATION_FAILED` | Committee status is invalid. |
| 607 | `VALIDATION_FAILED` | Invitation expiry or use limit is invalid. |
| 636 | `RESOURCE_CONFLICT` | This account already has an active seat in the committee. |
| 698 | `FORBIDDEN` | System administrator access is required. |
| 699 | `VALIDATION_FAILED` | Rule package scope is invalid. |
| 741 | `FORBIDDEN` | Built-in rule packages cannot be modified. |
| 743 | `FORBIDDEN` | System administrator access is required. |
| 770 | `VALIDATION_FAILED` | Simulation facts are invalid. |
| 773 | `VALIDATION_FAILED` | Rule simulation failed. |
| 783 | `VALIDATION_FAILED` | Rule package version is not published. |
| 788 | `VALIDATION_FAILED` | Rule package version is invalid. |
| 811 | `VALIDATION_FAILED` | Rule override scope is invalid. |
| 824 | `VALIDATION_FAILED` | Rule override creates an invalid package. |

#### `server/src/modules/stage4/database.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 45 | `RESOURCE_CONFLICT` | The requested resource already exists. |
| 48 | `VALIDATION_FAILED` | The request contains an invalid reference or value. |
| 82 | `BAD_REQUEST` | Idempotency-Key is required. |
| 108 | `FORBIDDEN` | Change the temporary password first. |
| 121 | `RESOURCE_CONFLICT` | The committee is read-only. |
| 128 | `RESOURCE_CONFLICT` | The committee is paused. |
| 141 | `FORBIDDEN` | Chair capability is required. |

#### `server/src/modules/stage4/service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 149 | `VALIDATION_FAILED` | Base revision is invalid. |
| 156 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 164 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 171 | `VALIDATION_FAILED` | Content is invalid. |
| 178 | `VALIDATION_FAILED` | Sort order is invalid. |
| 432 | `VALIDATION_FAILED` | Country template key is invalid. |
| 541 | `FORBIDDEN` | Built-in templates cannot be deleted. |
| 546 | `RESOURCE_CONFLICT` | This country template is still in use. |
| 597 | `FORBIDDEN` | Built-in templates cannot be changed. |
| 647 | `FORBIDDEN` | Built-in templates cannot be deleted. |
| 1022 | `FORBIDDEN` | System administrators cannot create committees. |
| 1033 | `VALIDATION_FAILED` | Committee visibility is invalid. |
| 1035 | `VALIDATION_FAILED` | Committee operation mode is invalid. |
| 1040 | `VALIDATION_FAILED` | Choose one committee template or one country template. |
| 1053 | `VALIDATION_FAILED` | Rule package version is not published. |
| 1055 | `VALIDATION_FAILED` | Rule package version is invalid. |
| 1132 | `VALIDATION_FAILED` | Seat properties are invalid. |
| 1165 | `VALIDATION_FAILED` | Seat patch is invalid. |
| 1169 | `VALIDATION_FAILED` | Seat patch is empty. |
| 1188 | `VALIDATION_FAILED` | Seat properties are invalid. |
| 1283 | `FORBIDDEN` | Chair capability is required. |
| 1289 | `VALIDATION_FAILED` | Seat is invalid. |
| 1317 | `FORBIDDEN` | You can only edit your own text posts. |
| 1344 | `FORBIDDEN` | You can only delete your own text posts. |
| 1369 | `VALIDATION_FAILED` | The active rule package has invalid phases. |
| 1376 | `VALIDATION_FAILED` | Missing general list action is invalid. |
| 1379 | `VALIDATION_FAILED` | Phase is not defined by the active rule package. |
| 1383 | `RESOURCE_CONFLICT` | More than one meeting session is pending. |
| 1411 | `RESOURCE_CONFLICT` | The previous general speakers list is missing. |
| 1470 | `RESOURCE_CONFLICT` | Meeting session is already closed. |
| 1474 | `RESOURCE_CONFLICT` | Complete or reset the active roll call first. |
| 1498 | `RESOURCE_CONFLICT` | Meeting session is closed. |
| 1506 | `VALIDATION_FAILED` | The rule package has invalid roll-call responses. |
| 1510 | `RESOURCE_CONFLICT` | The committee has no active seats. |
| 1540 | `RESOURCE_CONFLICT` | Roll call is not in progress. |
| 1543 | `RESOURCE_CONFLICT` | Record the current seat first. |
| 1544 | `VALIDATION_FAILED` | Roll-call response is not allowed. |
| 1547 | `VALIDATION_FAILED` | Seat is not part of this roll call. |
| 1600 | `RESOURCE_CONFLICT` | Roll call is not active. |
| 1603 | `VALIDATION_FAILED` | Roll-call response is not allowed. |
| 1608 | `VALIDATION_FAILED` | Seat is not part of this roll call. |
| 1682 | `RESOURCE_CONFLICT` | Only an active roll call can be undone. |
| 1687 | `RESOURCE_CONFLICT` | Roll call has no response to undo. |
| 1708 | `RESOURCE_CONFLICT` | Roll call is not active. |
| 1741 | `VALIDATION_FAILED` | Attendance event type is invalid. |
| 1749 | `RESOURCE_CONFLICT` | Meeting session is closed. |
| 1752 | `VALIDATION_FAILED` | Seat is invalid. |
| 1779 | `FORBIDDEN` | Chair capability is required. |
| 1780 | `VALIDATION_FAILED` | A represented seat is required. |
| 1783 | `FORBIDDEN` | Only a Chair can act for another seat. |
| 1787 | `FORBIDDEN` | An active seat assignment is required. |
| 1793 | `RESOURCE_CONFLICT` | Meeting session is closed. |
| 1796 | `VALIDATION_FAILED` | Seat is invalid. |
| 1800 | `VALIDATION_FAILED` | The rule package has invalid point types. |
| 1805 | `VALIDATION_FAILED` | Point type is not active in the meeting rule package. |
| 1833 | `VALIDATION_FAILED` | Point resolution status is invalid. |
| 1839 | `VALIDATION_FAILED` | Attendance change is invalid. |
| 1844 | `VALIDATION_FAILED` | Attendance event type is invalid. |
| 1852 | `RESOURCE_CONFLICT` | Point has already been resolved. |
| 1856 | `VALIDATION_FAILED` | Only a personal privilege point can change attendance. |
| 1887 | `VALIDATION_FAILED` | Text resource patch is invalid. |
| 1890 | `VALIDATION_FAILED` | Text resource patch is empty. |

#### `server/src/modules/stage5/service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 95 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 102 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 109 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 126 | `VALIDATION_FAILED` | Motion duration is invalid. |
| 129 | `VALIDATION_FAILED` | Motion duration is invalid. |
| 378 | `VALIDATION_FAILED` | Document rule action is invalid. |
| 384 | `VALIDATION_FAILED` | Document action is not available in the frozen rule package. |
| 397 | `FORBIDDEN` | Chair capability is required in Chair-operated mode. |
| 399 | `FORBIDDEN` | A delegate cannot choose another seat. |
| 402 | `FORBIDDEN` | An active seat assignment is required. |
| 406 | `FORBIDDEN` | The represented seat is not present. |
| 457 | `VALIDATION_FAILED` | Timer owner type is invalid. |
| 496 | `RESOURCE_CONFLICT` | The timer is already running. |
| 497 | `RESOURCE_CONFLICT` | Reset or extend the timer before starting it. |
| 500 | `RESOURCE_CONFLICT` | The timer is not running. |
| 507 | `RESOURCE_CONFLICT` | The timer has not expired. |
| 533 | `VALIDATION_FAILED` | Speaker list kind is invalid. |
| 540 | `VALIDATION_FAILED` | Delegate queue setting is invalid. |
| 544 | `VALIDATION_FAILED` | Caucus duration must allow one complete speech. |
| 553 | `RESOURCE_CONFLICT` | Meeting session is closed. |
| 557 | `RESOURCE_CONFLICT` | The main speakers list already exists. |
| 593 | `VALIDATION_FAILED` | A speaker list change is required. |
| 611 | `VALIDATION_FAILED` | Delegate queue setting is invalid. |
| 649 | `VALIDATION_FAILED` | Speaker list status is invalid. |
| 725 | `VALIDATION_FAILED` | Speaker stance is invalid. |
| 734 | `RESOURCE_CONFLICT` | Speaker list is closed. |
| 740 | `FORBIDDEN` | Chair capability is required in Chair-operated mode. |
| 743 | `FORBIDDEN` | Delegate self-queueing is disabled for this speaker list. |
| 745 | `FORBIDDEN` | A delegate cannot choose another seat. |
| 748 | `FORBIDDEN` | An active seat assignment is required. |
| 752 | `VALIDATION_FAILED` | Only a present active seat may join the queue. |
| 786 | `RESOURCE_CONFLICT` | Speaker list is closed. |
| 793 | `RESOURCE_CONFLICT` | The speaker is no longer in the active queue. |
| 879 | `VALIDATION_FAILED` | Queue order is invalid. |
| 889 | `RESOURCE_CONFLICT` | Speaker list is closed. |
| 896 | `VALIDATION_FAILED` | Queue order must contain every waiting speaker once. |
| 926 | `RESOURCE_CONFLICT` | Speaker list is closed. |
| 930 | `RESOURCE_CONFLICT` | Pause the current speech before advancing the list. |
| 934 | `RESOURCE_CONFLICT` | Complete the current speech before advancing the list. |
| 1000 | `RESOURCE_CONFLICT` | The speaker list has no current speaker. |
| 1013 | `RESOURCE_CONFLICT` | A speech is already active. |
| 1017 | `RESOURCE_CONFLICT` | The speech timers cannot start. |
| 1021 | `RESOURCE_CONFLICT` | The current speaker is invalid. |
| 1030 | `RESOURCE_CONFLICT` | There is no active speech. |
| 1034 | `RESOURCE_CONFLICT` | The speech is not running. |
| 1038 | `RESOURCE_CONFLICT` | The speech cannot resume. |
| 1041 | `RESOURCE_CONFLICT` | The speech is already complete. |
| 1097 | `VALIDATION_FAILED` | Yield type is invalid. |
| 1114 | `RESOURCE_CONFLICT` | speech.kind === 'INHERITED' ? 'Inherited speaking time cannot be yielded again.' : 'Pause the speech with more than one second remaining before yielding.' |
| 1123 | `VALIDATION_FAILED` | Yield target seat is not present. |
| 1124 | `VALIDATION_FAILED` | A speaker cannot yield to the same seat. |
| 1128 | `VALIDATION_FAILED` | This yield type does not accept a target seat. |
| 1226 | `VALIDATION_FAILED` | Yield decision is invalid. |
| 1243 | `RESOURCE_CONFLICT` | There is no pending delegate yield to decide. |
| 1261 | `RESOURCE_CONFLICT` | The target seat is no longer present. |
| 1312 | `VALIDATION_FAILED` | Contribution type is invalid. |
| 1323 | `RESOURCE_CONFLICT` | This speech does not accept that contribution. |
| 1328 | `FORBIDDEN` | Chair capability is required in Chair-operated mode. |
| 1330 | `FORBIDDEN` | A delegate cannot choose another seat. |
| 1333 | `FORBIDDEN` | An active seat assignment is required. |
| 1336 | `VALIDATION_FAILED` | Seat is invalid. |
| 1368 | `VALIDATION_FAILED` | Motion parameters are invalid. |
| 1376 | `FORBIDDEN` | Chair capability is required in Chair-operated mode. |
| 1378 | `FORBIDDEN` | A delegate cannot choose another seat. |
| 1382 | `FORBIDDEN` | An active seat assignment is required. |
| 1386 | `RESOURCE_CONFLICT` | Meeting session is closed. |
| 1390 | `VALIDATION_FAILED` | Only a present active seat may propose a motion. |
| 1396 | `VALIDATION_FAILED` | Motion type is not active in the meeting rule package. |
| 1402 | `VALIDATION_FAILED` | Motion second requirement is invalid. |
| 1406 | `FORBIDDEN` | Only a Chair can record an initial seconder. |
| 1407 | `VALIDATION_FAILED` | This motion does not require a seconder. |
| 1410 | `VALIDATION_FAILED` | The proposer and seconder must be different seats. |
| 1415 | `VALIDATION_FAILED` | Only a present active seat may second a motion. |
| 1477 | `RESOURCE_CONFLICT` | This motion no longer accepts seconds. |
| 1481 | `FORBIDDEN` | Chair capability is required in Chair-operated mode. |
| 1483 | `FORBIDDEN` | A delegate cannot choose another seat. |
| 1486 | `VALIDATION_FAILED` | A different present seat must second the motion. |
| 1491 | `VALIDATION_FAILED` | Only a present active seat may second a motion. |
| 1517 | `RESOURCE_CONFLICT` | The meeting session is not open. |
| 1520 | `RESOURCE_CONFLICT` | Complete or reset the active roll call first. |
| 1523 | `RESOURCE_CONFLICT` | A meeting session is already pending. |
| 1556 | `RESOURCE_CONFLICT` | The meeting session is not open. |
| 1560 | `RESOURCE_CONFLICT` | The general speakers list is missing. |
| 1629 | `RESOURCE_CONFLICT` | There is no unmoderated caucus timer to extend. |
| 1647 | `VALIDATION_FAILED` | Speaker time must evenly divide the caucus time. |
| 1665 | `RESOURCE_CONFLICT` | The target resolution has not been introduced. |
| 1670 | `RESOURCE_CONFLICT` | The target resolution already has an associated caucus. |
| 1725 | `RESOURCE_CONFLICT` | The target caucus is not open. |
| 1798 | `RESOURCE_CONFLICT` | The target caucus is not open. |
| 1801 | `RESOURCE_CONFLICT` | The caucus timer is unavailable. |
| 1823 | `RESOURCE_CONFLICT` | Only an unintroduced draft resolution can be introduced. |
| 1831 | `RESOURCE_CONFLICT` | Publish the resolution content file before introducing the draft. |
| 1875 | `RESOURCE_CONFLICT` | Only a draft amendment can be introduced. |
| 1882 | `RESOURCE_CONFLICT` | Add amendment text or a file before introducing it. |
| 1884 | `RESOURCE_CONFLICT` | Publish the amendment content file before introducing it. |
| 1918 | `RESOURCE_CONFLICT` | Only an introduced amendment can enter voting. |
| 1947 | `RESOURCE_CONFLICT` | Only an introduced resolution can enter voting. |
| 1990 | `VALIDATION_FAILED` | Motion result is invalid. |
| 1999 | `RESOURCE_CONFLICT` | The motion has already been decided. |
| 2005 | `RESOURCE_CONFLICT` | The motion does not have the required seconds. |
| 2030 | `VALIDATION_FAILED` | The non-voting-seat setting is invalid. |
| 2039 | `RESOURCE_CONFLICT` | The motion has already been decided. |
| 2044 | `RESOURCE_CONFLICT` | This setting is locked after delegate voting starts. |
| 2046 | `RESOURCE_CONFLICT` | This direct-vote setting is already selected. |
| 2074 | `VALIDATION_FAILED` | Vote choice is invalid. |
| 2082 | `RESOURCE_CONFLICT` | The motion has already been decided. |
| 2088 | `FORBIDDEN` | Delegate motion voting is disabled. |
| 2090 | `FORBIDDEN` | A delegate cannot choose another seat. |
| 2094 | `FORBIDDEN` | An active seat assignment is required. |
| 2099 | `FORBIDDEN` | This seat is not eligible for the direct vote. |
| 2101 | `VALIDATION_FAILED` | Procedural motion votes cannot abstain. |
| 2107 | `RESOURCE_CONFLICT` | choice === null ? 'This seat has no current vote to retract.' : 'This seat already has that vote.' |
| 2111 | `RESOURCE_CONFLICT` | This seat has no current vote to retract. |
| 2158 | `RESOURCE_CONFLICT` | Only a pending motion can be withdrawn. |
| 2181 | `VALIDATION_FAILED` | Ballot subject type is invalid. |
| 2184 | `VALIDATION_FAILED` | Ballot procedure type is invalid. |
| 2186 | `VALIDATION_FAILED` | Ballot threshold is invalid. |
| 2195 | `RESOURCE_CONFLICT` | Meeting session is closed. |
| 2202 | `RESOURCE_CONFLICT` | The motion belongs to another meeting session. |
| 2204 | `RESOURCE_CONFLICT` | The motion is not ready for voting. |
| 2207 | `VALIDATION_FAILED` | The ballot procedure type does not match the frozen motion rule. |
| 2211 | `RESOURCE_CONFLICT` | The motion already has a ballot. |
| 2219 | `RESOURCE_CONFLICT` | The document has not entered formal voting. |
| 2228 | `VALIDATION_FAILED` | The ballot has no eligible seats. |
| 2274 | `VALIDATION_FAILED` | Vote choice is invalid. |
| 2282 | `RESOURCE_CONFLICT` | The ballot is not open. |
| 2286 | `FORBIDDEN` | Chair capability is required in Chair-operated mode. |
| 2288 | `FORBIDDEN` | A delegate cannot choose another seat. |
| 2292 | `FORBIDDEN` | This seat is not eligible for the ballot. |
| 2294 | `VALIDATION_FAILED` | This seat cannot cast that choice. |
| 2320 | `VALIDATION_FAILED` | Vote choice is invalid. |
| 2328 | `RESOURCE_CONFLICT` | The ballot is not open. |
| 2333 | `VALIDATION_FAILED` | The corrected vote is invalid. |
| 2361 | `VALIDATION_FAILED` | Vote choice is invalid. |
| 2369 | `RESOURCE_CONFLICT` | The ballot is not open. |
| 2376 | `FORBIDDEN` | Delegate motion voting is disabled. |
| 2378 | `FORBIDDEN` | A delegate cannot choose another seat. |
| 2383 | `FORBIDDEN` | This seat is not eligible for the ballot. |
| 2385 | `VALIDATION_FAILED` | This seat cannot cast that choice. |
| 2391 | `RESOURCE_CONFLICT` | This seat has no current vote to retract. |
| 2393 | `RESOURCE_CONFLICT` | This seat already has that vote. |
| 2440 | `RESOURCE_CONFLICT` | The ballot is not open. |
| 2449 | `RESOURCE_CONFLICT` | Required eligible votes have not all been cast. |
| 2471 | `RESOURCE_CONFLICT` | Close the ballot before publishing. |
| 2480 | `RESOURCE_CONFLICT` | The ballot motion is no longer awaiting a result. |
| 2505 | `RESOURCE_CONFLICT` | The ballot document is not in voting state. |
| 2539 | `VALIDATION_FAILED` | Strawpoll voting mode is invalid. |
| 2542 | `VALIDATION_FAILED` | Strawpoll choice mode is invalid. |
| 2545 | `VALIDATION_FAILED` | Strawpoll options are invalid. |
| 2548 | `VALIDATION_FAILED` | Strawpoll medium is invalid. |
| 2551 | `VALIDATION_FAILED` | Strawpoll option permission is invalid. |
| 2555 | `VALIDATION_FAILED` | Strawpoll options must be unique. |
| 2564 | `RESOURCE_CONFLICT` | Meeting session is closed. |
| 2568 | `VALIDATION_FAILED` | Manual strawpolls do not use anonymous voting. |
| 2598 | `VALIDATION_FAILED` | Strawpoll choices are invalid. |
| 2601 | `VALIDATION_FAILED` | Strawpoll choices are invalid. |
| 2611 | `RESOURCE_CONFLICT` | The strawpoll is not accepting linked votes. |
| 2614 | `VALIDATION_FAILED` | Select one strawpoll option. |
| 2618 | `VALIDATION_FAILED` | Strawpoll choice is invalid. |
| 2621 | `VALIDATION_FAILED` | Anonymous strawpoll votes cannot be retracted. |
| 2623 | `VALIDATION_FAILED` | Anonymous votes do not use seats. |
| 2626 | `FORBIDDEN` | Anonymous strawpoll access is invalid. |
| 2639 | `VALIDATION_FAILED` | Seat strawpolls do not use anonymous credentials. |
| 2644 | `FORBIDDEN` | Chair capability is required in Chair-operated mode. |
| 2646 | `FORBIDDEN` | A delegate cannot choose another seat. |
| 2649 | `FORBIDDEN` | An active committee seat is required. |
| 2652 | `FORBIDDEN` | The represented seat is not present. |
| 2657 | `RESOURCE_CONFLICT` | This seat has no current strawpoll vote to retract. |
| 2660 | `RESOURCE_CONFLICT` | This seat already selected those strawpoll options. |
| 2701 | `RESOURCE_CONFLICT` | The strawpoll is not voting. |
| 2724 | `VALIDATION_FAILED` | Strawpoll voting configuration is invalid. |
| 2727 | `VALIDATION_FAILED` | Strawpoll round settings are invalid. |
| 2730 | `VALIDATION_FAILED` | Strawpoll options must be unique. |
| 2740 | `RESOURCE_CONFLICT` | This strawpoll round is no longer current. |
| 2747 | `FORBIDDEN` | A Chair is required to edit this strawpoll. |
| 2752 | `FORBIDDEN` | A present seat is required. |
| 2760 | `FORBIDDEN` | Delegates may only add one option to this strawpoll. |
| 2794 | `VALIDATION_FAILED` | Strawpoll stage action is invalid. |
| 2803 | `RESOURCE_CONFLICT` | This strawpoll round is no longer current. |
| 2807 | `RESOURCE_CONFLICT` | The strawpoll is in another stage. |
| 2809 | `VALIDATION_FAILED` | Enter a strawpoll question. |
| 2811 | `VALIDATION_FAILED` | At least two options are required to start a strawpoll. |
| 2832 | `VALIDATION_FAILED` | Manual tally is invalid. |
| 2841 | `RESOURCE_CONFLICT` | This strawpoll is not accepting manual tallies. |
| 2849 | `RESOURCE_CONFLICT` | The manual tally is unchanged. |
| 2900 | `FORBIDDEN` | Only the amendment proposer or a Chair may delete it. |
| 2905 | `RESOURCE_CONFLICT` | An amendment cannot be deleted after voting begins. |
| 2939 | `RESOURCE_CONFLICT` | Meeting session is closed. |
| 2950 | `VALIDATION_FAILED` | Amendment and resolution must use the same meeting session. |
| 2952 | `RESOURCE_CONFLICT` | The resolution does not accept amendments. |
| 2999 | `VALIDATION_FAILED` | A document body must use either text or a file. |
| 3004 | `VALIDATION_FAILED` | Content file is unavailable. |
| 3006 | `VALIDATION_FAILED` | Amendment content is invalid. |
| 3011 | `RESOURCE_CONFLICT` | The document version is frozen. |
| 3014 | `FORBIDDEN` | Only the proposer or a Chair may create a new version. |
| 3045 | `VALIDATION_FAILED` | Document action is invalid. |
| 3057 | `RESOURCE_CONFLICT` | A draft document can only be introduced by a passed motion. |
| 3065 | `RESOURCE_CONFLICT` | The document is not in the required state. |
| 3096 | `VALIDATION_FAILED` | No document setting was supplied. |
| 3109 | `VALIDATION_FAILED` | This setting is only available for resolutions. |
| 3116 | `VALIDATION_FAILED` | \`${name} is not present.\` |
| 3123 | `VALIDATION_FAILED` | The proposer and seconder must be different seats. |
| 3126 | `VALIDATION_FAILED` | The delegate amendment setting is invalid. |
| 3130 | `VALIDATION_FAILED` | The direct-vote majority is invalid. |
| 3142 | `VALIDATION_FAILED` | The proposer and seconder must be different seats. |
| 3144 | `RESOURCE_CONFLICT` | The document settings are unchanged. |
| 3152 | `RESOURCE_CONFLICT` | The document settings are unchanged. |
| 3176 | `VALIDATION_FAILED` | Vote choice is invalid. |
| 3192 | `FORBIDDEN` | This seat is not eligible for the resolution vote. |
| 3193 | `VALIDATION_FAILED` | This seat must vote for or against. |
| 3199 | `RESOURCE_CONFLICT` | choice === null ? 'This seat has no current vote to retract.' : 'This seat already has that vote.' |
| 3203 | `RESOURCE_CONFLICT` | This seat has no current vote to retract. |
| 3249 | `VALIDATION_FAILED` | Document result is invalid. |
| 3250 | `RESOURCE_CONFLICT` | Introduce the amendment before recording its result. |
| 3253 | `RESOURCE_CONFLICT` | Publish the formal ballot result for this amendment. |
| 3257 | `RESOURCE_CONFLICT` | This result is already recorded. |
| 3260 | `VALIDATION_FAILED` | A correction reason is required. |
| 3261 | `VALIDATION_FAILED` | An initial result does not use a correction reason. |
| 3298 | `RESOURCE_CONFLICT` | The document is not open for discussion. |

#### `server/src/modules/storage-agent/chair-provider-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 33 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 82 | `FORBIDDEN` | Only the upload creator may commit it. |
| 86 | `RESOURCE_CONFLICT` | Upload is not ready for host commit. |
| 94 | `RESOURCE_CONFLICT` | Upload host commit is already terminal. |
| 102 | `RESOURCE_CONFLICT` | Chair Agent storage is not active. |
| 148 | `RESOURCE_CONFLICT` | Cache refill is incomplete. |
| 213 | `RESOURCE_CONFLICT` | Host commit no longer matches its upload. |
| 224 | `FORBIDDEN` | Upload creator is no longer active. |

#### `server/src/modules/storage-agent/conflict-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 32 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 39 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 50 | `VALIDATION_FAILED` | Conflict resolution is invalid. |
| 58 | `VALIDATION_FAILED` | Logical name is invalid. |
| 67 | `VALIDATION_FAILED` | Logical name is not a safe portable path. |
| 102 | `FORBIDDEN` | Chair or committee owner access is required. |
| 168 | `RESOURCE_CONFLICT` | Content on a revoked host cannot be accepted. |
| 171 | `RESOURCE_CONFLICT` | Deleted content must be saved as a new file. |
| 174 | `RESOURCE_CONFLICT` | Only local content can be saved as a new file. |

#### `server/src/modules/storage-agent/local-change-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 16 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 24 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 31 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 38 | `VALIDATION_FAILED` | SHA-256 is invalid. |
| 45 | `VALIDATION_FAILED` | Local change is invalid. |
| 53 | `VALIDATION_FAILED` | Existing file ID and revision must be provided together. |
| 69 | `VALIDATION_FAILED` | Local change kind is invalid. |
| 157 | `RESOURCE_CONFLICT` | Resolution content is invalid. |
| 206 | `CHAIR_DECISION_REQUIRED` | This local file change conflicts with the server state. |

#### `server/src/modules/storage-agent/service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 76 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 83 | `VALIDATION_FAILED` | Revision is invalid. |
| 90 | `VALIDATION_FAILED` | Lease generation is invalid. |
| 97 | `VALIDATION_FAILED` | Pairing purpose is invalid. |
| 104 | `VALIDATION_FAILED` | Device label is invalid. |
| 111 | `VALIDATION_FAILED` | Device public key is invalid. |
| 115 | `VALIDATION_FAILED` | Device public key is invalid. |
| 139 | `FORBIDDEN` | Chair or committee owner access is required. |
| 203 | `RESOURCE_CONFLICT` | The committee already has a storage host. |
| 206 | `RESOURCE_CONFLICT` | The committee has no storage host to transfer. |
| 255 | `RESOURCE_CONFLICT` | Storage host state changed before pairing completed. |
| 380 | `RESOURCE_CONFLICT` | Storage host is no longer active. |
| 512 | `VALIDATION_FAILED` | Agent capabilities are invalid. |

#### `server/src/modules/storage-agent/task-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 88 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 95 | `VALIDATION_FAILED` | Cursor is invalid. |
| 103 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 110 | `VALIDATION_FAILED` | SHA-256 is invalid. |
| 117 | `VALIDATION_FAILED` | Failure code is invalid. |
| 125 | `VALIDATION_FAILED` | Failure reason is invalid. |
| 192 | `RESOURCE_CONFLICT` | Storage Agent task is not held by this claim. |
| 267 | `RESOURCE_CONFLICT` | Storage Agent task is already claimed. |
| 271 | `RESOURCE_CONFLICT` | Storage Agent task cannot be claimed. |
| 301 | `RESOURCE_CONFLICT` | Storage Agent content does not match its task. |
| 334 | `RESOURCE_CONFLICT` | Storage Agent content is no longer expected. |
| 369 | `RESOURCE_CONFLICT` | Blob does not match its storage Agent task. |
| 376 | `RESOURCE_CONFLICT` | Source upload is not ready for its storage Agent task. |
| 433 | `RESOURCE_CONFLICT` | Storage Agent content is not staged. |
| 436 | `RESOURCE_CONFLICT` | Verified staged content cannot be failed. |

#### `server/src/modules/storage/cache-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 11 | `VALIDATION_FAILED` | Blob ID is invalid. |

#### `server/src/modules/storage/credential-crypto.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 18 | `VALIDATION_FAILED` | S3 credentials are invalid. |
| 25 | `VALIDATION_FAILED` | S3 credentials are invalid. |

#### `server/src/modules/storage/file-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 105 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 112 | `VALIDATION_FAILED` | Revision is invalid. |
| 343 | `FORBIDDEN` | Only the file owner or Chair may submit this file. |
| 346 | `FORBIDDEN` | Chair or committee owner access is required. |
| 349 | `RESOURCE_CONFLICT` | File status does not allow this action. |

#### `server/src/modules/storage/migration-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 61 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 68 | `VALIDATION_FAILED` | Revision is invalid. |
| 128 | `VALIDATION_FAILED` | Target provider type is invalid. |
| 133 | `VALIDATION_FAILED` | SERVER_VOLUME does not use a provider config. |
| 189 | `RESOURCE_CONFLICT` | This storage migration cannot be retried. |
| 193 | `RESOURCE_CONFLICT` | The target storage binding is unavailable. |
| 268 | `RESOURCE_CONFLICT` | Storage bindings changed during migration. |
| 282 | `RESOURCE_CONFLICT` | Target storage is not fully verified. |
| 304 | `RESOURCE_CONFLICT` | This storage migration cannot be cancelled. |
| 483 | `RESOURCE_CONFLICT` | Target blob metadata conflicts with this copy. |
| 492 | `RESOURCE_CONFLICT` | Target blob copy conflicts with this migration. |
| 536 | `RESOURCE_CONFLICT` | The target provider is already active. |
| 557 | `FORBIDDEN` | Chair or committee owner access is required. |

#### `server/src/modules/storage/paths.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 8 | `VALIDATION_FAILED` | Storage key is invalid. |
| 18 | `VALIDATION_FAILED` | Storage key is invalid. |

#### `server/src/modules/storage/s3-commit-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 48 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 54 | `BAD_REQUEST` | Idempotency-Key is required. |
| 70 | `FORBIDDEN` | Committee membership is required. |
| 104 | `FORBIDDEN` | Only the upload creator may commit it. |
| 111 | `RESOURCE_CONFLICT` | Upload is not ready for provider commit. |
| 115 | `RESOURCE_CONFLICT` | The S3 provider config changed. |
| 159 | `FORBIDDEN` | Only the upload creator may commit it. |
| 164 | `RESOURCE_CONFLICT` | Upload is not ready for provider commit. |
| 177 | `RESOURCE_CONFLICT` | Upload provider target is invalid. |
| 190 | `RESOURCE_CONFLICT` | The active storage provider is not S3 compatible. |

#### `server/src/modules/storage/s3-config-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 38 | `FORBIDDEN` | System administrator access is required. |
| 44 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 51 | `VALIDATION_FAILED` | Revision is invalid. |
| 58 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 87 | `VALIDATION_FAILED` | S3 provider options are invalid. |
| 139 | `VALIDATION_FAILED` | Provider config status is invalid. |

#### `server/src/modules/storage/s3-endpoint.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 37 | `VALIDATION_FAILED` | S3 endpoint resolves to a disallowed network address. |
| 46 | `VALIDATION_FAILED` | S3 endpoint is invalid. |
| 50 | `VALIDATION_FAILED` | S3 endpoint must be an HTTPS URL without credentials, query, or fragment. |
| 54 | `VALIDATION_FAILED` | S3 endpoint hostname is not allowed. |
| 59 | `VALIDATION_FAILED` | S3 bucket is invalid. |
| 62 | `VALIDATION_FAILED` | S3 region is invalid. |
| 66 | `VALIDATION_FAILED` | S3 key prefix is invalid. |
| 74 | `VALIDATION_FAILED` | Blob ID is invalid. |

#### `server/src/modules/storage/server-volume-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 54 | `FORBIDDEN` | Committee membership is required. |
| 62 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 78 | `BAD_REQUEST` | Idempotency-Key is required. |
| 126 | `FORBIDDEN` | Only the upload creator may commit it. |
| 132 | `RESOURCE_CONFLICT` | Upload is not ready for provider commit. |
| 183 | `FORBIDDEN` | Only the upload creator may commit it. |
| 188 | `RESOURCE_CONFLICT` | Upload is not ready for provider commit. |
| 201 | `RESOURCE_CONFLICT` | Upload provider target is invalid. |
| 213 | `RESOURCE_CONFLICT` | The active storage provider is not SERVER_VOLUME. |

#### `server/src/modules/storage/service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 79 | `VALIDATION_FAILED` | Revision is invalid. |
| 86 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 93 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 100 | `VALIDATION_FAILED` | SHA-256 is invalid. |
| 107 | `VALIDATION_FAILED` | File size is invalid. |
| 162 | `FORBIDDEN` | Chair or committee owner access is required. |
| 175 | `FORBIDDEN` | Committee membership is required. |
| 233 | `RESOURCE_CONFLICT` | The committee already has active storage. |
| 279 | `RESOURCE_CONFLICT` | The committee already has active storage. |
| 314 | `RESOURCE_CONFLICT` | The committee already has active storage. |
| 369 | `VALIDATION_FAILED` | Target file ID is only valid for a new file. |
| 383 | `RESOURCE_CONFLICT` | The storage binding is not active. |
| 395 | `FORBIDDEN` | Only the file owner or Chair may add a version. |
| 398 | `VALIDATION_FAILED` | Revision is only valid for an existing file. |
| 468 | `FORBIDDEN` | Only the file owner or Chair may delete this file. |

#### `server/src/modules/storage/upload-service.ts`

| 行 | 错误码 | 代码中的原因 |
| ---: | --- | --- |
| 73 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 80 | `VALIDATION_FAILED` | \`${name} is invalid.\` |
| 87 | `VALIDATION_FAILED` | File size is invalid. |
| 126 | `FORBIDDEN` | Committee membership is required. |
| 141 | `BAD_REQUEST` | Idempotency-Key is required. |
| 212 | `RESOURCE_CONFLICT` | The committee has no active storage. |
| 288 | `FORBIDDEN` | Only the upload creator may send its content. |
| 296 | `RESOURCE_CONFLICT` | Upload content is not expected in its current state. |
| 319 | `RESOURCE_CONFLICT` | Upload content is not expected in its current state. |
| 355 | `RESOURCE_CONFLICT` | Upload content is not expected in its current state. |

