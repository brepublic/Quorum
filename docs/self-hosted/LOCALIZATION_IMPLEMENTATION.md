# 多语言与委员会快照实施记录

本记录配合 `LOCALIZATION_REDESIGN.md` 使用。未完成项目不算通过；本记录不代表全计划交付。

## 实施前基线（2026-09-18）

实施前有 22 个已跟踪文件修改及 4 个未跟踪文件，主要为主题开关、否决权徽标、Undo 显示、验证记录及已确认计划。已在用户要求提交后独立保存为 `c029462`，没有混入本次共享语言模型。该提交重新运行 6 个相关测试文件、140 项测试通过，diff 空白检查通过；其中既有部署和数据库验收记录未在本次重复执行。

## P0 源码盘点及实现决定

| 入口/存储 | 核实的当前行为 | 后续改造 |
| --- | --- | --- |
| `stage4/service.ts#createCommittee`、HTTP stage4 路由 | 严格字段白名单、持久幂等、复制模板成员；国家目录未复制；成员按模板默认语言命名 | 请求强制语言、所选规则版本、来源 revision；同事务保存完整目录、成员和初始规则绑定 |
| `stage3/service.ts#createCommittee`、HTTP stage3 路由 | 独立创建事务；HTTP 逐字段转发；无模板/语言校验 | 统一创建约束和幂等摘要；不留绕过入口 |
| `stage3/service.ts#createSeat`、`stage4/service.ts#createSeat/updateSeat` | 接受客户端 displayName；stage4 接受 flag；更新权限等已有行为独立 | 新建仅选择固定目录标识；拒绝名称、别名和身份变更；数据库同时约束 |
| `SelfHostedWorkspace.tsx` 设置席位 | 以实时国家目录覆盖席位名称，可能覆盖特殊模板成员名 | 使用固定成员定义，新增使用固定国家目录 |
| `stage4/service.ts#workspaceSnapshot` | Owner/Chair 读取源国家模板；公开和 Member 不返回目录 | 固定副本替换实时读取，保留原权限过滤 |
| `stage3/service.ts#activateRules/overrideRule` | 激活追加绑定；FUTURE 调整创建发布版本；ONCE 有独立操作记录 | 校验委员会语言，保持已有执行语义及资源冻结边界 |
| `stage5/service.ts`、`ProceedingsPanel.tsx`、`WorkspaceNavigation.tsx` | 自动名称写入英文/中文字符串；`localizeGeneratedName` 用正则判断 | 持久编号、显式 customTitle、按资源关联规则版本取历史名称 |
| `delegate-files/service.ts#suggestedNames` | 根据提交日期映射会期，按会期和文件类型计数已批准文件；一次批量查询 | 返回类型及数字，按委员会语言格式化；正式文件名继续原样保存 |
| `server/http/errors.ts` | code/message/details；身份客户端、业务 fetch、XHR、代表下载/上传分别处理 | reason/受约束 params/fieldErrors；所有客户端按标识解析 |
| `storage-agent/src/client.ts/errors.ts/desktop-bridge.ts`、Rust/Slint | 独立网络、桥接及桌面错误路径 | 同步错误标识、语言保存和状态文案；实际不兼容时才升级协议 |
| `operations/archive-service.ts` | 绑定导出包括实际规则 definition；会期、发言名单缺 name，文档依赖 title | 同步显式 SELECT、固定目录/成员、编号及所有实际使用规则版本 |

### 编号归属（保持现状）

- 会期：委员会内，当前由 count + 1 生成中文名称；stage4 开会和 stage5 暂停/休会均会创建。
- 决议：会期内，显示会期序号和决议序号。
- 修正案：**委员会内**，当前查询没有按父决议分组；不得改为每份决议内编号。
- 意向性投票：会期内。
- 文件建议：提交所属会期内，同类型已批准文件数 + 1；不建立正式文件编号唯一性。
- 分配方案：委员会行锁下维护会期/修正案计数，会期行维护决议/意向性投票计数；唯一约束与不可改号约束配合。逻辑删除不回收编号。完整迁移和并发验证尚未实施。

### 固定内容与规则生命周期

使用现有委员会行中的一份 `content_snapshot` JSON，结构版本 1，包含完整国家模板（含名称和旗帜）、委员会模板来源 ID/revision 和全部成员定义、`initialRulePackageVersionId`。模板成员保留自身 stableKey、名称和初始权限；不能按旗帜推断国家身份。`committee_language` 必填且与固定内容一起禁止普通更新。来源 ID 仅溯源，不作为显示时的必需外键。

继续复用不可变 `rule_package_versions` 和 `committee_rule_bindings`，无需额外执行器或每个委员会复制系统规则：

- migration 3 禁止修改/删除已发布版本；migration 24 只为拥有该版本的委员会的受控永久删除提供例外。
- 删除 worker 仅删除 `rule_packages.committee_id = 被删除委员会` 的规则；系统和内置规则不在删除范围内。
- 激活服务拒绝引用其他委员会的 COMMITTEE 规则包；外键也会阻止删除仍有业务引用的版本。
- 账号处置转移模板与规则包 owner，不删除版本；retention 不清理规则版本及议事历史。
- 归档需要额外涵盖 FUTURE 调整生成但尚未激活、以及资源冻结边界实际引用的定义，不能仅检查当前活动规则。
- 以上是源码/约束盘点；源删除、账号处置和跨委员会删除的新增 PostgreSQL 验收仍待实施。

当前 IMAGE 旗帜被服务端限制为内嵌 WebP data URL，固定 JSON 复制会同时包含字节；没有独立内部资源文件需要增加回收引用计数。

### 旧数据及迁移边界

新迁移不得修改历史 migration，不推断旧字符串的自动/自定义来源。选择对含旧委员会的数据库明确拒绝升级，并按计划限定重建委员会业务数据；保留账号和无关配置。实际重建脚本、目标 Compose 实例核查、受控删除及新 migration 尚未执行。中间版本不部署。

## 已实施的基础代码

- `packages/contracts/src/localization.ts`：支持语言类型、固定内容结构、完整目录/成员语言检查、语言交集、严格内容取名及仅动议允许的语言回退、显式自动名称格式化。
- `packages/rule-schema/src/localization.ts`：规则内容的实际名称/标签/术语缺失位置检查；包标题双语不能掩盖规则正文缺失。
- 自动名称格式化只读取 kind、ordinal、customTitle/question，不比较用户字符串；这是后续服务端和 Web 接线的基础，旧字符串路径目前仍存在。
- 共享包测试共 8 个文件、36 项通过（包含新增的 17 项）；`pnpm build:self-host` 通过。规则包初次编译发现 unknown 类型缩窄问题，已修正并重新构建通过。
- 现有业务请求、数据库和界面名称尚未接入这些纯函数，因此不计为 A1–A9 端到端通过。

## 阶段状态

| 阶段 | 状态 |
| --- | --- |
| P0 | 源码入口、编号、规则复用、旧数据处理方案已记录；运行验证随后续阶段执行 |
| P1 | 共享模型与纯函数已实现；SQL、现有请求/响应替换、错误结构、schema/归档版本未完成 |
| P2–P3 | 未实施 |
| P4 | 未实施 |
| P5–P6 | 未实施；没有部署或数据库重建 |
