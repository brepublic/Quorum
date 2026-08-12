# Quorum 主题 API 2 指南

本文档定义 Quorum 声明式主题格式、能力边界和发布要求。主题 API 2 的目标不是让主题文件接管页面 CSS，而是在不破坏业务布局、语义和无障碍的前提下，允许作者定制一套完整、可验证的视觉语言。

旧版主题 API 1 仍可导入，但只作为兼容格式维护。新主题必须使用 API 2。

## 1. 能力边界

### API 2 可以控制

- 浅色或深色模式；每个主题必须固定选择一种。
- 画布、表面、正文、次要正文、强调、成功、警告、危险、边框和焦点颜色。
- 系统、人文、圆体或等宽字体预设，以及小、标准、大三档字号比例。
- 紧凑、舒适、宽松三档密度。
- 页面和控件圆角预设。
- 实色或半透明表面，以及平面、轻层级、强层级阴影。
- 无、弱、标准、流畅四档动态预设。
- 按钮、开关、导航和表格的受控外观变体。
- 默认内容宽度，以及稳定页面 ID 的白名单宽度覆盖。

### API 2 不能控制

- 不能提供 CSS、选择器、HTML、JavaScript、图片、字体文件或外部 URL。
- 不能隐藏、重排或重新定位关键业务控件。
- 不能更改点名、表决、动议、计时器、权限、Firebase 数据或路由行为。
- 不能改写业务文案、用伪元素制造状态，或只靠颜色替代真实状态。
- 不能为任意类名设置页面布局；只能为文档列出的稳定页面选择内容宽度。
- 不能修改主题管理器和右下角恢复入口。

这些限制由解析器执行，而不是依赖作者自律。未知字段会被拒绝。

## 2. 文件格式

主题是一个 UTF-8 JSON 文件，建议以 `.quorum-theme.json` 结尾。完整示例：

```json
{
  "schema": "quorum-theme",
  "schemaVersion": 2,
  "manifest": {
    "id": "example.daylight",
    "name": "Daylight",
    "version": "2.0.0",
    "author": "Your name",
    "description": "A readable fixed light theme.",
    "quorumThemeApi": "2",
    "colorScheme": "light"
  },
  "settings": {
    "palette": {
      "canvas": "#f5f5f7",
      "surface": "#ffffff",
      "surfaceRaised": "#ffffff",
      "text": "#1d1d1f",
      "textMuted": "#5f5f65",
      "accent": "#0066cc",
      "accentText": "#ffffff",
      "success": "#187a34",
      "successText": "#ffffff",
      "warning": "#ffb340",
      "warningText": "#1d1d1f",
      "danger": "#b42318",
      "dangerText": "#ffffff",
      "border": "#8e8e93",
      "focus": "#005fcc"
    },
    "typography": {"fontFamily": "system", "scale": "standard"},
    "density": "comfortable",
    "shape": {"radius": "rounded", "controls": "rounded"},
    "materials": {"surface": "translucent", "depth": "subtle"},
    "motion": {"preset": "fluid"},
    "components": {
      "buttons": "tinted",
      "switches": "ios",
      "navigation": "floating",
      "tables": "cards"
    },
    "layout": {
      "contentWidth": "wide",
      "pageWidths": {"committee-resolution": "full"}
    }
  }
}
```

顶层只允许 `schema`、`schemaVersion`、`manifest` 和 `settings`。API 2 文件中出现 `css` 或其他未知字段会导入失败。

## 3. Manifest

| 字段 | 规则 |
| --- | --- |
| `id` | 必填；2–64 个字母、数字、点、下划线或连字符；不能以 `builtin` 开头；发布后保持稳定 |
| `name` | 必填；最多 80 字符 |
| `version` | 必填；最多 32 字符；建议使用语义化版本 |
| `author` | 必填；最多 80 字符 |
| `description` | 可选；最多 500 字符 |
| `quorumThemeApi` | 必须是字符串 `2` |
| `colorScheme` | 必须是 `light` 或 `dark`；API 2 不接受 `auto` |

浅色和深色应作为两个不同 ID 的主题发布。例如 `example.daylight` 和 `example.midnight`。这样用户的选择不依赖操作系统状态，导出、迁移和问题复现也更确定。

## 4. Palette 与对比度

颜色必须是完整六位十六进制值，例如 `#0066cc`。不接受透明色、短十六进制、CSS 变量或函数。

| 字段 | 用途 |
| --- | --- |
| `canvas` | 页面底层画布 |
| `surface` | 卡片、内容段和普通面板 |
| `surfaceRaised` | 输入框、下拉菜单、浮层和较高层级表面 |
| `text` | 正文和主要标题 |
| `textMuted` | 说明、元数据和次要标签 |
| `accent` / `accentText` | 主操作、当前导航和焦点动作 |
| `success` / `successText` | 成功、出席、赞成 |
| `warning` / `warningText` | 警告、弃权、当前代表团 |
| `danger` / `dangerText` | 错误、缺席、反对和危险操作 |
| `border` | 控件和表面边界 |
| `focus` | 键盘焦点环 |

导入器会强制检查：

- `text` 对 `canvas`、`surface`、`surfaceRaised` 至少 4.5:1。
- `textMuted` 对 `canvas`、`surface` 至少 4.5:1。
- 四组语义前景色对对应背景色至少 4.5:1。
- `focus` 对 `canvas`、`surface` 至少 3:1。

状态语义固定：主题不能把 `success` 改用于危险操作，也不能把所有语义按钮合并成强调色。

## 5. Typography、Density 与 Shape

### `typography.fontFamily`

- `system`：平台系统字体，推荐默认值。
- `humanist`：人文无衬线字体栈。
- `rounded`：平台圆体字体栈。
- `monospace`：等宽字体栈，适合实验性或技术主题。

主题不能嵌入或下载字体。

### `typography.scale`

- `small`
- `standard`
- `large`

字号档位会连同布局一起缩放；不能传入任意像素值。

### `density`

- `compact`
- `comfortable`
- `spacious`

密度影响间距和控件高度，但不会把点击目标缩到不可操作。

### `shape`

- `radius`：`square`、`soft`、`rounded`。
- `controls`：`rounded`、`pill`。

复选框、单选框、Toggle 和 Slider 各自有独立形态规则。通用圆角设置不会覆盖 Toggle 的胶囊轨道或圆形滑块。iOS 开关的实际输入和标签点击区域至少为 44px，拇指使用可立即反向的 `transform` 过渡。

## 6. Materials 与 Motion

### `materials.surface`

- `solid`：不透明表面。
- `translucent`：由 Quorum 生成半透明表面和背景模糊；启用“减少透明度”时自动回退为实色。

### `materials.depth`

- `flat`
- `subtle`
- `elevated`

### `motion.preset`

- `none`：无主题附加动态。
- `reduced`：短颜色和透明度反馈，不使用明显位移。
- `standard`：克制的工作台动态。
- `fluid`：更明显但仍受时长上限约束的界面动态。

Quorum 使用统一的进入、移动和按压曲线。主题不能注入关键帧。系统启用 `prefers-reduced-motion` 时，位移和循环动画会被移除，但有助理解的短颜色反馈会保留。

`fluid` 预设仍遵守 300ms 上限：状态颜色约 160ms、开关位移 200ms、下拉和通知进入 240ms、侧栏 300ms。首页与委员会侧栏共享同一 `push` 空间模型。通知不再使用 Semantic UI 默认的 500ms 多次回弹；弹窗使用 `scale(.97 → 1)`、透明度和材质模糊的同步进入效果。`reduced` 和系统减少动态模式会把这些位移改为短透明度反馈。

决议结果标题的既有瞬时闪烁属于业务交互契约，不由主题预设改写。

## 7. Components

| 字段 | 可选值 | 控制范围 |
| --- | --- | --- |
| `buttons` | `filled`、`tinted` | 普通按钮的中性表面；主操作和语义按钮继续使用对应 palette |
| `switches` | `ios`、`compact` | Toggle 和 Slider 的轨道、滑块和移动方式 |
| `navigation` | `bar`、`floating` | 委员会导航是贴合栏还是浮动材质栏 |
| `tables` | `plain`、`cards` | 表格是普通边界还是带圆角和层级的卡片表面 |

组件设置不能删除标签、图标、禁用状态或焦点状态。

## 8. Layout

`layout.contentWidth` 是默认内容宽度：

- `readable`：适合说明和表单的窄阅读宽度。
- `wide`：适合管理界面的宽内容区。
- `full`：不设主题最大宽度。

`layout.pageWidths` 可以覆盖稳定页面，但值仍只能使用以上三档。允许的页面 ID：

`home`、`onboard`、`templates`、`countries`、`account-admin`、`committee-home`、`committee-setup`、`committee-roll-call`、`committee-motions`、`committee-caucus`、`committee-unmod`、`committee-resolution`、`committee-strawpoll`、`committee-notes`、`committee-posts`、`committee-stats`、`committee-settings`、`committee-help`、`committee-unknown`、`not-found`。

宽度只作用于非 `fluid` 内容容器。决议、点名、国家管理等业务页面自己声明的全宽容器不会被主题的普通内容宽度压缩。

API 2 不允许设置 Grid 列数、`order`、固定定位、显示/隐藏或任意断点，从格式层保护点名矩阵、表决按钮对齐和手机单列布局。

## 9. 导入、存储与兼容

- 导入后立即启用；相同 ID 会覆盖旧版本。
- 导入主题和当前选择只保存在浏览器 `localStorage`，不写入 Firebase。
- 新运行时使用 v2 本地存储键，并会自动读取旧 v1 键中的主题和当前选择。
- 导出会生成已规范化的完整主题包，包括补齐后的默认设置。
- 右下角恢复入口和主题管理器始终位于主题作用域外。
- 完整文件仍不得超过 3 MiB。

### API 1 兼容层

API 1 文件仍使用 `schemaVersion: 1`、`quorumThemeApi: "1"` 和 `css` 字符串。它会继续经过作用域、外部资源和大小检查，但任意 CSS 可能破坏布局或对比度。Quorum 会在主题管理器中标记它为“旧版 CSS 主题”。

不提供 API 1 到 API 2 的自动转换，因为任意选择器和布局规则无法安全映射成有限设置。应人工提取颜色、排版、形状、材质和宽度意图，重新发布 API 2 主题。

## 10. 发布检查清单

1. 文件能成功导入、覆盖、导出并重新导入。
2. 浅色和深色分别使用固定 `colorScheme` 和不同 ID。
3. 所有 palette 对比度通过导入器校验。
4. 首页、账号页、模板、国家管理和全部委员会页面都可读。
5. 普通、悬停、焦点、禁用、加载、错误和空状态均可区分。
6. Toggle、Slider、普通复选框和单选框形态正确且点击目标足够大。
7. 320px 手机、平板和宽屏没有关键控件遮挡或不可达。
8. 简体中文和英语长文本不会溢出。
9. 减少动态、减少透明度和高对比度偏好仍可使用。
10. 文件不包含 `css`、资源、脚本或未记录字段。
