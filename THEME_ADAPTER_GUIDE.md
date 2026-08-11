# Quorum 外观主题适配指南

本文档面向 Quorum 主题作者。主题 API 1 允许一个主题彻底改变现有页面的视觉语言：颜色、字体、留白、边框、阴影、动效、按钮形态，以及 Grid、Flex、定位等布局方式都可以覆盖。主题只控制表现层，不能执行 JavaScript、读写 Firebase、修改业务状态、增加路由或创建新页面。

## 1. 最短上手路径

1. 新建 UTF-8 JSON 文件，文件名建议以 `.quorum-theme.json` 结尾。
2. 按下文填写 `manifest`，把全部主题 CSS 写入 `css` 字符串。
3. 在 Quorum 任意页面右下角打开“外观主题”，选择“导入主题”。
4. 修改文件后再次导入。同一个 `manifest.id` 会覆盖浏览器中已安装的旧版本并立即启用。
5. 用“导出当前主题”触发浏览器下载，交付或备份这个单文件主题包。

最小的可导入示例：

```json
{
  "schema": "quorum-theme",
  "schemaVersion": 1,
  "manifest": {
    "id": "example.midnight",
    "name": "Midnight Assembly",
    "version": "1.0.0",
    "author": "Your name",
    "description": "A compact dark conference-room theme.",
    "quorumThemeApi": "1",
    "colorScheme": "dark"
  },
  "css": ":scope { --accent: #7dd3fc; min-height: 100vh; color: #e5eef8; background: #08111f; }\n[data-theme-component~='button'] { border-radius: 999px !important; }\n:scope[data-theme-page='committee-roll-call'] .roll-call-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }"
}
```

JSON 字符串中的换行必须写成 `\n`，双引号必须写成 `\"`。实际制作时可以用构建脚本把单独的 CSS 文件转义进 JSON；最终交付物仍是一个文件。

## 2. 主题包格式

顶层字段：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `schema` | 字符串 | 必须是 `quorum-theme` |
| `schemaVersion` | 数字 | 当前必须是 `1` |
| `manifest` | 对象 | 主题身份和兼容信息 |
| `css` | 字符串 | 主题的全部 CSS，最多 2 MiB |

`manifest` 字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 2–64 个字母、数字、点、下划线或连字符；建议采用 `作者.主题名`，发布后不要更换 |
| `name` | 是 | 显示名称，最多 80 字符 |
| `version` | 是 | 主题版本，最多 32 字符；建议使用语义化版本 |
| `author` | 是 | 作者，最多 80 字符 |
| `description` | 否 | 简介，最多 500 字符 |
| `quorumThemeApi` | 是 | 当前必须是字符串 `1` |
| `colorScheme` | 否 | `light`、`dark` 或 `auto`，供原生控件和主题选择器使用 |

完整文件不得超过 3 MiB。浏览器把导入主题保存在本机 `localStorage`；它不随账号同步，也不会写入 Firebase。不同浏览器或设备之间迁移时，先导出再导入。

## 3. 作用域与根选择器

Quorum 在应用主题时自动把 `css` 放进以下原生 CSS 作用域：

```css
@scope (#quorum-app) {
  /* 主题包的 css 会出现在这里 */
}
```

因此主题只能影响 `#quorum-app` 内的应用界面（包括 Quorum 的业务弹窗），不能影响作用域外的主题恢复按钮和主题管理弹窗。不要在主题文件中再写 `@scope (#quorum-app)`。

主题 API 1 依赖浏览器原生 `@scope`。该能力从 2025 年 12 月起进入最新浏览器的 Baseline；Quorum 仍建议使用新版 Chrome。旧浏览器可能继续显示默认界面，却忽略自定义主题 CSS，详见 [MDN 的 `@scope` 兼容说明](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40scope)。

作用域根本身用 `:scope` 选择：

```css
:scope {
  --theme-accent: #8b5cf6;
  background: #0f172a;
  color: #e2e8f0;
  font-family: Inter, system-ui, sans-serif;
}

:scope[data-theme-color-scheme='dark'] {
  color-scheme: dark;
}
```

主题 CSS 在 Quorum 内置 CSS 之后加载。遇到 Semantic UI 的高优先级规则或组件的行内样式时，可以增加选择器具体度；确有必要时才使用 `!important`。

## 4. 页面适配钩子

应用根会一直携带以下属性：

```html
<div id="quorum-app" data-theme-id="example.midnight"
  data-theme-section="committee" data-theme-page="committee-roll-call"
  data-theme-color-scheme="dark">
```

`data-theme-section` 的稳定值为 `public`、`account`、`committee`、`system`。`data-theme-page` 与现有页面的对应关系如下；这是主题 API 1 的稳定契约：

| 页面 | `data-theme-page` |
| --- | --- |
| 首页 `/` | `home` |
| 登录/创建委员会 `/onboard`、`/committees` | `onboard` |
| 委员会模板 | `templates` |
| 国家模板 | `countries` |
| 账号管理 | `account-admin` |
| 委员会欢迎页 | `committee-home` |
| 委员会设置 | `committee-setup` |
| 点名 | `committee-roll-call` |
| 动议 | `committee-motions` |
| 主发言名单或有主持核心磋商 | `committee-caucus` |
| 自由磋商 | `committee-unmod` |
| 决议草案及其全部标签页 | `committee-resolution` |
| 意向性投票 | `committee-strawpoll` |
| 笔记 | `committee-notes` |
| 帖子与附件 | `committee-posts` |
| 统计 | `committee-stats` |
| 委员会行为设置 | `committee-settings` |
| 帮助 | `committee-help` |
| 未知委员会子路径 | `committee-unknown` |
| 404 | `not-found` |

页面专用规则必须把页面条件写在 `:scope` 上：

```css
:scope[data-theme-page='home'] .ui.vertical.segment {
  min-height: 100svh !important;
}

:scope[data-theme-page='committee-resolution'] .resolution-voting-dashboard {
  grid-template-columns: minmax(0, 2fr) minmax(18rem, 1fr);
}
```

## 5. 通用组件适配钩子

Quorum 会在界面挂载和动态更新后，为常见组件添加空格分隔的 `data-theme-component` 令牌。请使用 `~=`，不要使用严格等于：同一个节点可能同时属于多个类别。

| 令牌 | 组件 |
| --- | --- |
| `button`、`button-group` | 按钮、按钮组 |
| `container`、`grid`、`segment` | 容器、网格、内容段 |
| `menu`、`sidebar` | 菜单、移动端侧栏 |
| `form`、`input`、`checkbox`、`dropdown` | 表单控件 |
| `table`、`list`、`feed`、`card` | 数据和内容集合 |
| `modal`、`message` | 弹窗和消息 |
| `heading`、`label`、`statistic`、`progress` | 标题、标签、统计和进度 |

示例：

```css
[data-theme-component~='button'] {
  background: linear-gradient(135deg, #14b8a6, #2563eb) !important;
  border: 0 !important;
  border-radius: 0.75rem !important;
  box-shadow: 0 0.4rem 1rem rgb(2 132 199 / 24%) !important;
  color: white !important;
}

[data-theme-component~='segment'] {
  background: rgb(15 23 42 / 84%) !important;
  border: 1px solid rgb(148 163 184 / 18%) !important;
}
```

这些通用令牌适合建立整体设计语言。需要控制一个页面内的具体业务组件时，可继续使用源码已经提供的语义类名，例如：

- 点名：`.roll-call-board`、`.roll-call-grid`、`.roll-call-member`、`.roll-call-current`、`.roll-call-summary-highlights`
- 决议表决：`.resolution-voting-dashboard`、`.resolution-voting-grid`、`.resolution-voting-metric`、`.resolution-voting-actions`
- 动议：`.motion`、`.motion-heading`、`.motion-vote-panel`、`.motion-vote-result`
- 国家模板：`.country-manager-layout`、`.country-manager-sidebar`、`.country-editor-table`、`.country-flag-editor`
- 模板选择：`.template-picker-row`、`.template-preview`、`.template-localized-name-row`
- 委员会导航：`.committee-menu`

通用 `data-theme-*` 是版本化主题 API；业务类名可提供更细的控制，但可能随对应功能重构而变化。发布主题前应在下方列出的所有页面复测。

## 6. 彻底改变布局

主题不能改 React 组件树，但可以利用 CSS Grid、Flex、`order`、`grid-template-areas`、`display: contents`、绝对/固定定位和容器查询重新组织现有组件。例如把点名界面改成“当前代表团居左、代表团矩阵居右”：

```css
:scope[data-theme-page='committee-roll-call'] .roll-call-board {
  display: grid;
  gap: 1.5rem;
  grid-template-columns: minmax(16rem, 0.8fr) minmax(30rem, 2fr);
}

:scope[data-theme-page='committee-roll-call'] .roll-call-current {
  grid-column: 1;
  grid-row: 1 / span 2;
}

:scope[data-theme-page='committee-roll-call'] .roll-call-grid,
:scope[data-theme-page='committee-roll-call'] .roll-call-pagination {
  grid-column: 2;
}

@media (max-width: 800px) {
  :scope[data-theme-page='committee-roll-call'] .roll-call-board {
    grid-template-columns: 1fr;
  }
}
```

CSS 不能把本来不存在的数据变出来，也不能改变事件处理器归属。不要用伪元素伪造业务文案或状态；主题隐藏关键操作时，功能虽然仍在代码中，但用户将无法使用。

## 7. 图片、字体与其他资源

主题包是单文件。图片、小图标和字体必须以 base64 `data:` URL 内嵌：

```css
:scope[data-theme-page='home'] {
  background-image: url('data:image/webp;base64,UklGR...');
}
```

主题导入器拒绝 `@import`、`@charset`、`@namespace`、外部/相对 URL、`http:`、`https:`、`file:`、`ftp:` 和 `blob:`，因此主题不会在应用之外静默加载资源。建议把图片转换为 WebP/AVIF，并控制体积；如果单个主题接近 3 MiB，应优先压缩素材而不是拆包，因为当前 API 1 的可移植交付格式就是一个 JSON 文件。

如需字体，可优先使用系统字体栈。内嵌字体前确认浏览器允许在作用域规则中使用对应的 `@font-face` 写法，并在所有目标浏览器验证；大字体也很容易超过主题包上限。

## 8. 状态、响应式与无障碍

主题必须覆盖真实交互状态，而不只是静态截图：

- `:hover`、`:focus-visible`、`:active`、`:disabled`
- Semantic UI 的 `.active`、`.loading`、`.error`、`.positive`、`.negative`、`.inverted`
- 点名的 `.status-uncalled`、`.status-absent`、`.status-present`、`.is-current`
- 投票的 `.vote-for`、`.vote-against`、`.vote-abstaining` 与禁用状态
- 桌面、平板、手机宽度，长中文、长英文、动态列表和空状态
- `prefers-reduced-motion: reduce` 与键盘焦点可见性

不要只依靠颜色传达出席、表决或错误状态。正文和控件应满足 WCAG AA 对比度；点击目标建议至少 44×44 CSS 像素。重新定位浮层时要检查下拉菜单、弹窗、侧栏和通知的 `z-index`。

## 9. 导入、覆盖、删除和恢复

- 导入成功后主题立即启用；同 ID 导入会覆盖旧包。
- 导出会下载当前主题的完整 JSON。内置默认主题也能导出；重新导入它会安全地切回内置默认样式。
- 删除自定义主题后自动切回默认主题。
- 主题解析失败、版本不兼容、资源 URL 不合规或本地存储空间不足时，不会替换当前主题。
- 即使主题 CSS 写坏，右下角主题按钮和管理弹窗也位于作用域外，可用于切回 `Quorum Default`。
- 清除站点数据会同时清除已安装主题和当前选择；重要主题请先导出。

## 10. 发布前适配清单

1. JSON 能成功导入、覆盖、导出，并能在另一个浏览器重新导入。
2. 首页、登录/创建委员会、委员会模板、国家模板和账号管理均已检查。
3. 委员会欢迎、设置、点名、动议、两类磋商、决议全部标签、意向性投票、笔记、帖子、统计、行为设置和帮助均已检查。
4. 普通、悬停、焦点、禁用、加载、错误、空数据与长数据状态均清晰可辨。
5. 320 px 手机宽度到宽屏均无关键控件遮挡或不可达。
6. 英语和简体中文均无溢出、拆词错误或不可读文本。
7. 键盘可操作，焦点可见，减少动态效果偏好生效。
8. 主题未隐藏关键业务控件，未用视觉内容冒充真实系统状态。
9. 文件小于 3 MiB，CSS 小于 2 MiB，资源全部使用 base64 data URL。
10. `quorumThemeApi` 仍为目标 Quorum 版本支持的 API；若未来升级主题 API，应按新的迁移说明更新。
