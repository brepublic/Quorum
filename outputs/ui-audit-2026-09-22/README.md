# 2026-09-22 浏览器检查证据

主报告：[`docs/reviews/2026-09-22-browser-interaction-layout-audit.md`](../../docs/reviews/2026-09-22-browser-interaction-layout-audit.md)。

本目录保存本轮浏览器的 JPEG 截图及对应 `.txt` 页面结构。`zh`／`en` 表示界面语言，委员会固定内容可能使用另一种语言。`390`／`320` 指经页面 `innerWidth` 确认的 CSS 宽度。截图缩放和图片像素不用于代替页面尺寸测量。

| 重点 | 证据 |
| --- | --- |
| 人工计票输入回退 | [A8/B0](zh-poll-count-conflict.jpg)、[恢复后的8/7](zh-poll-result.jpg) |
| 模板成功提示失真 | [仍显示已保存](en-template-stale-saved.jpg)、[刷新记录](en-template-reload.txt) |
| 未保存国家被丢弃 | [切换前](en-country-unsaved.jpg)、[返回后](en-country-draft-lost.jpg) |
| 空国家保存无反馈、按钮相贴 | [桌面页面](en-country-empty-save.jpg) |
| 国家表格撑宽 | [390px](en-country-390.jpg) |
| 文件子导航裁切 | [中文390px](zh-files-390.jpg)、[英文320px](en-files-320.jpg) |
| 撤销按钮越界 | [可撤销时](en-voting-undo-clipped-390.jpg) |
| 主席电脑上传无完成回执 | [上传页](zh-upload-after-complete.jpg)、[待审核文件](zh-files-pending.jpg) |
| 问题规则空态 | [默认规则](zh-points-no-options.jpg) |
| 问题结果状态 | [北京规则处理后](en-point-upheld.jpg) |
| 同一文件状态不同 | [总览](zh-files-published.jpg)、[决议引用](en-resolution-file-status.jpg) |
| 计时操作差异 | [自由磋商](zh-unmod-running.jpg)、[发言名单](zh-speaker-paused.jpg) |
| 中文文件选择器混入英文 | [上传页](zh-upload-native.jpg) |
| 居中确认参考 | [文件驳回](zh-file-reject-dialog.jpg)、[模板删除](en-template-delete-dialog.jpg) |
| 下拉菜单出屏 | [直接测量值](dropdown-speaker-bottom-clipped.geometry.json)、[页面结构](dropdown-speaker-bottom-clipped.txt) |
| 键盘高亮项不随滚动显示 | [菜单画面](dropdown-speaker-keyboard-hidden.jpg)、[坐标](dropdown-speaker-keyboard-hidden.geometry.json) |
| 弹窗内下拉框 | [桌面](dropdown-rejection-modal-desktop.jpg)、[390px](dropdown-rejection-modal-390.jpg) |
| 代表入口覆盖限制 | [过期提示](en-delegate-expired.jpg) |

截图中的测试数据与真实操作范围以主报告为准。文件永久删除入口触发后浏览器控制超时，没有原生确认框截图，也未确认执行永久删除。

下拉框专项的完整覆盖表在主报告中。补查的其他展开状态使用 `dropdown-` 前缀。部分响应式截图带有工具产生的缩放与空白，不能按图片尺寸推算 CSS 视口；边界数字采用实际 DOM 测量。整理中发现的旧标签页错配截图已替换或删除。
