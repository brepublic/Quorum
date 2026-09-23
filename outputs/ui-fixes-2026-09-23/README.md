# 修复验收证据 · 2026-09-23

配套[验收报告](../../docs/reviews/2026-09-23-ui-fixes-acceptance.md)。`.jpg` 为真实浏览器截图，同名 `.txt` 为对应页面结构；几何记录单独保存为 JSON。截图采集工具在视口覆盖时可能保留外围空白，尺寸判断以页面 DOM 测量为准。

- [chair-agent-upload-complete](chair-agent-upload-complete.jpg) · [页面结构](chair-agent-upload-complete.txt)
- [country-discard-confirmation-en](country-discard-confirmation-en.jpg) · [页面结构](country-discard-confirmation-en.txt)
- [country-discard-restored-en](country-discard-restored-en.jpg) · [页面结构](country-discard-restored-en.txt)
- [country-flag-menu-320-en](country-flag-menu-320-en.jpg) · [页面结构](country-flag-menu-320-en.txt)
- [country-template-320-zh](country-template-320-zh.jpg) · [页面结构](country-template-320-zh.txt)
- [created-with-default-rule](created-with-default-rule.jpg) · [页面结构](created-with-default-rule.txt)
- [file-delete-centered-confirmation](file-delete-centered-confirmation.jpg) · [页面结构](file-delete-centered-confirmation.txt)
- [file-navigation-320-en](file-navigation-320-en.jpg) · [页面结构](file-navigation-320-en.txt)
- [file-navigation-390-zh](file-navigation-390-zh.jpg) · [页面结构](file-navigation-390-zh.txt)
- [file-replacement-green-confirmation](file-replacement-green-confirmation.jpg) · [页面结构](file-replacement-green-confirmation.txt)
- [final-rule-default-zh](final-rule-default-zh.jpg) · [页面结构](final-rule-default-zh.txt)
- [gsl-keyboard-short-window](gsl-keyboard-short-window.jpg) · [页面结构](gsl-keyboard-short-window.txt)
- [manual-tallies-18-17](manual-tallies-18-17.jpg) · [页面结构](manual-tallies-18-17.txt)
- [manual-tallies-after-reload](manual-tallies-after-reload.jpg) · [页面结构](manual-tallies-after-reload.txt)
- [moderated-menu-keyboard](moderated-menu-keyboard.jpg) · [页面结构](moderated-menu-keyboard.txt)
- [only-rule-default](only-rule-default.jpg) · [页面结构](only-rule-default.txt)
- [point-empty-reason-pending](point-empty-reason-pending.jpg) · [页面结构](point-empty-reason-pending.txt)
- [point-result-en](point-result-en.jpg) · [页面结构](point-result-en.txt)
- [points-empty-rule](points-empty-rule.jpg) · [页面结构](points-empty-rule.txt)
- [resolution-file-status](resolution-file-status.jpg) · [页面结构](resolution-file-status.txt)
- [resolution-voting-320-en](resolution-voting-320-en.jpg) · [页面结构](resolution-voting-320-en.txt)
- [template-draft-confirmation](template-draft-confirmation.jpg) · [页面结构](template-draft-confirmation.txt)
- [template-edited-clears-saved](template-edited-clears-saved.jpg) · [页面结构](template-edited-clears-saved.txt)
- [template-persisted-permission](template-persisted-permission.jpg) · [页面结构](template-persisted-permission.txt)
- [yield-menu-short-window](yield-menu-short-window.jpg) · [页面结构](yield-menu-short-window.txt)

- [发言名单几何测量](gsl-keyboard-short-window.json)
- [开发规则清理结果](rule-cleanup-result.json)


## 规则名称修正证据

`corrected-rule-{create,settings,help}-{zh,en}.jpg/.txt` 为用户指出规则名称漏检后的六组实测证据：中英文名称正确且无内部版本后缀，创建和设置页均展开了规则菜单。`only-rule-default`、`final-rule-default-zh` 是修正前的历史证据，包含当时遗漏的问题，不能用于证明最终名称正确。
