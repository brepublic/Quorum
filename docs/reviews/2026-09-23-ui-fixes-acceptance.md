# Quorum 交互与布局修复验收

日期：2026-09-23。对应[原始调查报告](2026-09-22-browser-interaction-layout-audit.md)。

## 结果

原报告 **01–12、15–16 已修复并完成针对性验收**；13（点击自由磋商计时数字开始／暂停）、14（浏览器原生文件选择控件）按用户明确要求保留。文件删除确认、替换批准按钮颜色及英文驳回文案也已统一。

本机开发环境只保留北京规则第 5 版，规则名为 **北京学术标准 2021**。新建委员会默认选中该规则，已经实际创建委员会验证。前后端容器已更新，`/health/ready` 返回 HTTP 200，数据库版本为 68。

## 逐项修复与验收

| 编号 | 实施方式 | 验收结果与主要证据 |
| --- | --- | --- |
| 01 | 人工票数按顺序保存，使用每次返回的新版本号；保留仍在编辑的草稿。查看结果／编辑选项等待票数提交完成。 | 浏览器连续输入 18／17 后立即查看结果，刷新仍为 18／17；延迟响应和失败保留输入由回归测试覆盖。[刷新后结果](../../outputs/ui-fixes-2026-09-23/manual-tallies-after-reload.jpg) |
| 02 | 保存状态由当前草稿是否发生变化共同决定，所有权限编辑都会使成功提示失效。 | 保存后开启 Veto，成功提示立即消失；再次保存、刷新，Veto 仍开启。[修改后](../../outputs/ui-fixes-2026-09-23/template-edited-clears-saved.jpg)、[刷新后](../../outputs/ui-fixes-2026-09-23/template-persisted-permission.jpg) |
| 03 | 国家与委员会模板均增加未保存检测、切换／新建确认及离开页面保护。异步载入批量更新草稿基线，兼容应用实际使用的 React 挂载方式。 | 取消切换保留输入；明确丢弃后恢复已保存内容；新建委员会模板前也会确认。[确认框](../../outputs/ui-fixes-2026-09-23/country-discard-confirmation-en.jpg)、[返回已保存内容](../../outputs/ui-fixes-2026-09-23/country-discard-restored-en.jpg) |
| 04 | 空国家名称显示行内错误并聚焦对应字段；图片旗帜未选择图片时也给出错误。 | 浏览器添加空国家后保存，出现“请填写国家名称”，焦点落在缺失字段；填写后能保存。回归测试覆盖无效行不提交。仍只要求任一已启用语言有名称。 |
| 05 | 未启用问题类型时隐藏无法使用的表单，展示必要空态。 | 清理旧规则前，旧默认规则页面显示“当前规则未启用问题”；北京规则页面保留完整表单并能提交。[空态](../../outputs/ui-fixes-2026-09-23/points-empty-rule.jpg) |
| 06 | 上传页保留上传标识，通过受权限保护的状态查询确认异步提交完成后显示现有成功回执。 | 主席电脑实际保存测试文件后，出现“文件已提交，等待审核”和文件名；待提交条目消失不再被直接当作成功。[完成回执](../../outputs/ui-fixes-2026-09-23/chair-agent-upload-complete.jpg) |
| 07 | 文件子导航允许换行，所有入口保持可达。 | 中文 390px、英文 320px 均可看到最后的文件设置；实际点击英文 File settings 成功。[中文](../../outputs/ui-fixes-2026-09-23/file-navigation-390-zh.jpg)、[英文](../../outputs/ui-fixes-2026-09-23/file-navigation-320-en.jpg) |
| 08 | 窄屏表决主操作保持三等分，撤销独立一行。 | 英文 320px 下投票后可点击 Undo；撤销按钮左右边界约 112.44／207.56px，页面宽度为 320px，无水平越界。[布局](../../outputs/ui-fixes-2026-09-23/resolution-voting-320-en.jpg) |
| 09 | 国家编辑表格在窄屏按字段纵向排列；取消固定最小宽度，收紧旗帜预览和选择器。 | 中英文 320px 下页面滚动宽度等于视口宽度；字段完整，旗帜菜单可展开。[中文](../../outputs/ui-fixes-2026-09-23/country-template-320-zh.jpg)、[英文菜单](../../outputs/ui-fixes-2026-09-23/country-flag-menu-320-en.jpg) |
| 10 | 模板操作区使用可换行的统一间距，删除按钮不再依赖浮动定位。 | 桌面模板保存／删除按钮间距约 10.5px；窄屏国家编辑操作按可用宽度换行，互不重叠。 |
| 11 | 问题信息沿用动议元数据表格，状态使用统一颜色、图标及完成语态。 | 新问题显示蓝色 Pending；处理后显示红色 Point overruled，已有已采纳问题显示绿色 Point upheld。[结果](../../outputs/ui-fixes-2026-09-23/point-result-en.jpg) |
| 12 | 文件总览、决议和修正案引用共用 `FileStatusLabel`。 | 浏览器检查已发布文件与决议引用的 Published 标签；修正案通过同一组件复用样式。[决议引用](../../outputs/ui-fixes-2026-09-23/resolution-file-status.jpg) |
| 13 | 保留既定设计。 | 未修改自由磋商计时数字的点击行为。 |
| 14 | 保留既定设计。 | 未替换浏览器原生文件选择控件。 |
| 15 | 发言席位菜单根据上下剩余空间选择展开方向，限制高度与水平范围。 | 在 1422×500 短窗口实测主发言名单、让渡和有主持磋商；菜单可见且内部可滚动。[主名单](../../outputs/ui-fixes-2026-09-23/gsl-keyboard-short-window.jpg)、[让渡](../../outputs/ui-fixes-2026-09-23/yield-menu-short-window.jpg) |
| 16 | 键盘激活项变化时滚动菜单到该项，补齐控制关系和激活项标识。 | 主名单连续向下到“美国”，末项出现在可视菜单内，Enter 正确选中；有主持磋商也检查到末项。[几何记录](../../outputs/ui-fixes-2026-09-23/gsl-keyboard-short-window.json)、[磋商菜单](../../outputs/ui-fixes-2026-09-23/moderated-menu-keyboard.jpg) |

本轮检查的下拉框还包括国家旗帜／大洲、界面语言、问题提出国、委员会模板和规则选择。未在这些覆盖状态中发现选项被父容器无故裁切。菜单内部滚动和靠近视口边缘时向上展开属于正常行为。验收不等于穷举任意窗口大小、所有数据组合或所有浏览器。

## 一致性补充

- 文件永久删除改为居中确认，最后操作保持红色；浏览器检查打开和取消，实际删除调用由组件及数据库测试覆盖。[确认框](../../outputs/ui-fixes-2026-09-23/file-delete-centered-confirmation.jpg)
- 同名替换批准的最终按钮使用绿色，与普通批准一致。浏览器触发同名替换确认并取消，核对按钮为 `ui positive button`。[替换确认](../../outputs/ui-fixes-2026-09-23/file-replacement-green-confirmation.jpg)
- 文件驳回操作使用 `Reject file`，不再复用问题裁决的状态文字。
- 实测发现主席问题的“原因可选”与数据库非空约束不一致。migration 68 允许存储空原因；代表模式仍由服务层要求非空。部署后不填原因成功提出问题并完成驳回。[待处理记录](../../outputs/ui-fixes-2026-09-23/point-empty-reason-pending.jpg)
- 测试发现旧 schema 55 清理脚本引用了 schema 67 才存在的 `resolution_countries`；已在该历史脚本中跳过这一查询，历史迁移测试通过。

## 规则与开发数据

保留版本 ID：`8ce2296c-2df0-4c18-ae1e-f4a4f0cea221`，包键 `builtin:beijing-academic`，版本 5。中文名称为“北京学术标准 2021”，英文名称为“Beijing Academic Standard 2021”。界面名称不附加内部版本号，没有改动该版本的议事行为。

`ensureBuiltins` 现在只初始化这一版本。旧 Quorum fixture 仍供 schema／历史兼容测试使用，不再出现在运行中的规则列表。

显式执行 `server/scripts/consolidate-development-rules.mjs --local-development-rebuild`，删除另外 9 个规则版本及以下委员会：

- 联合国安全理事会：`37dc3a8c-8cd6-49de-954f-507a4ede261b`
- Localization acceptance-EN：`7fccea9f-3640-49ee-9698-6d8deab66f4e`
- 多语言验收-ZH：`bd42a925-530a-46b7-ac5f-5c11bbd2e5e1`

清理使用事务和委员会受控清理流程；首次遇到缓存外键依赖时完整回滚，补齐依赖顺序后成功。账号、源国家／委员会模板及系统设置通过事务前后比较保持一致；已恢复规则不可变触发器。该脚本不由启动或数据库迁移自动执行。

重启后数据库仍只有一个规则版本。保留的 `UI audit 0922 EN` 和实际新建的 `修复验收 0923` 都关联该版本。[修正后的英文唯一规则选项](../../outputs/ui-fixes-2026-09-23/corrected-rule-create-en.jpg)、[修正后的中文默认值](../../outputs/ui-fixes-2026-09-23/corrected-rule-create-zh.jpg)

## 自动验证与部署

所有项目命令均先加载 `scripts/wsl-env.sh`。

| 验证 | 结果 |
| --- | --- |
| 完整单元测试 `pnpm test:self-host --maxWorkers=2 --minWorkers=1` | 89 个文件、689 项通过 |
| 完整 PostgreSQL 集成测试 `pnpm test:self-host:integration --maxWorkers=2 --minWorkers=1 --testTimeout=30000 --hookTimeout=30000` | 9 个文件、135 项通过；使用独立临时数据库 |
| migration 68 后重跑迁移及 stage4 集成测试 | 2 个文件、18 项通过，含主席空原因成功及代表空原因拒绝 |
| 最后界面改动后重跑委员会工作区、创建语言测试 | 2 个文件、94 项通过 |
| `pnpm build:self-host` 和最终 app／caddy 镜像构建 | 通过；保留原有大包体积提示 |
| 已运行容器与最新镜像比对 | app、caddy 镜像 ID 一致，app 为 healthy |
| `/health/ready` | HTTP 200；database migrationVersion=68，storage=ok |

首次完整单元测试受沙箱中的本地进程／端口限制出现超时，已以所需权限重跑通过。首次高并发数据库测试出现资源争用超时，同时暴露旧规则数量预期和历史清理脚本问题；调整测试预期、修复脚本并降低并发后完整通过。没有把这些失败计作成功。

浏览器验收使用用户指定的浏览器能力，覆盖中英文、320／390px 窄屏和短窗口；上传经过实际 Chair Agent。其他存储提供方的后端回归由集成测试覆盖，本轮没有逐个重新执行浏览器上传。最终恢复中文和默认视口，关闭本轮临时标签页。

## 提交与证据

- `8ea00a9`：原始调查报告、证据及用户确认范围。
- `0bfce60`：交互、布局、状态和上传回执修复。
- `17579e1`：唯一默认规则、开发清理及问题约束修复。
- 本文与[本轮证据目录](../../outputs/ui-fixes-2026-09-23/README.md)由后续验收文档提交保存。


## 规则名称补充修正（用户指出漏检后）

上一次验收漏掉了两个明确问题：把内部版本号 `· 5` 拼进显示名称，以及英文元数据误用了中文。此前将规则名称判为符合要求的结论不成立。旧 `only-rule-default`、`final-rule-default-zh` 截图保留为历史记录，不作为修正后的通过证据。

修复提交 `b98f794`：新建委员会、设置、帮助三处统一只显示当前界面语言对应的名称。内置 fixture、开发清理脚本及现有唯一规则的英文元数据均已更正。数据库修正仅更新这一个版本的名称，事务结束后确认不可变触发器已启用。

| 浏览器实际页面 | 中文证据 | 英文证据 |
| --- | --- | --- |
| 新建委员会默认规则及展开选项 | [北京学术标准 2021](../../outputs/ui-fixes-2026-09-23/corrected-rule-create-zh.jpg) | [Beijing Academic Standard 2021](../../outputs/ui-fixes-2026-09-23/corrected-rule-create-en.jpg) |
| 委员会设置及展开选项 | [中文](../../outputs/ui-fixes-2026-09-23/corrected-rule-settings-zh.jpg) | [英文](../../outputs/ui-fixes-2026-09-23/corrected-rule-settings-en.jpg) |
| 帮助页当前规则 | [中文](../../outputs/ui-fixes-2026-09-23/corrected-rule-help-zh.jpg) | [英文](../../outputs/ui-fixes-2026-09-23/corrected-rule-help-en.jpg) |

三处均无版本后缀，规则名称随界面语言切换；四个展开的规则菜单选项完整可见。每张截图有同名 `.txt` 页面快照。

本次重新运行创建语言与工作区测试：94 项通过；定向 PostgreSQL 规则初始化及不可变约束测试：1 项通过，2 项因名称过滤未运行。构建 app、caddy 成功，运行容器镜像 ID 与新镜像一致，健康检查 HTTP 200、schema 68。

实际浏览器验收入口为 `http://localhost:5173`，连接已更新的真实后端。额外尝试直接打开 `https://localhost` 时浏览器拒绝了本地证书（`ERR_CERT_AUTHORITY_INVALID`），没有绕过；因此未将 HTTPS 前端直连计为浏览器验收通过。
