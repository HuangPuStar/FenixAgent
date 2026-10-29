# OpenUI 组件目录

<!--
  本文档与 `@peri-code/sdk@0.3.0` 的 `src/openui/spec.json` 同步，由
  `packages/ui-components/web/__tests__/openui-skill-doc-sync.test.ts` 守护。
  格式契约：
  · `### ` 三级标题只用于组件，标题就是组件名，每个组件恰好出现一次；
  · 每个组件段落正文必须出现该组件签名里的全部必填参数名；
  · 签名与 spec.json 逐字一致，包括参数名、顺序、可选 `?` 与枚举值。
-->

## 语法速览

- 每行一条语句：`identifier = Expression`。
- 第一行必须是 `root = Stack([...])`；`Stack` 是唯一的根组件。
- 参数是位置参数，不能写命名参数；可选参数只能从末尾省略。
- 字符串用双引号；数组用 `[...]`；对象用 `{ key: value }`。
- 除 `root` 外，每个变量都必须被其它语句引用，否则静默丢弃。
- 一个助手消息只渲染一个顶层 ` ```openui ` 围栏。

## 组件

`Stack` / `Row` / `Grid` / `Card` 是容器；其余 28 个组件都是叶子，不接受 `children`。

### Stack

`Stack(children: (Grid | Card | Row | Text | H1 | H2 | H3 | Code | Link | Pill | Spacer | Divider | Callout | Stat | UsageBar | Gauge | DiffStats | DiffView | ChangedFiles | Sources | TodoList | Table | BarChart | LineChart | PieChart | TextInput | TextArea | Checkbox | Toggle | Select | Button)[], gap?: number)`

- **必填**：`children`。
- **children**（必填）：直接子项数组，可放 `Grid`、`Card`、`Row` 或任意叶子组件。`Stack` 是唯一允许作为程序 `root` 的组件。
- **gap**（可选）：子项间距，数字。
- 最小示例：`root = Stack([title])`

### Row

`Row(children: (Text | H1 | H2 | H3 | Code | Link | Pill | Spacer | Divider | Callout | Stat | UsageBar | Gauge | DiffStats | DiffView | ChangedFiles | Sources | TodoList | Table | BarChart | LineChart | PieChart | TextInput | TextArea | Checkbox | Toggle | Select | Button)[], gap?: number, align?: "start" | "center" | "end" | "stretch", justify?: "start" | "center" | "end" | "space-between", wrap?: boolean)`

- **必填**：`children`。
- **children**（必填）：只能是叶子组件，不能放 `Card` 或 `Grid`。
- **gap**（可选）：子项间距，数字。
- **align**（可选）：交叉轴对齐，取值 `"start" | "center" | "end" | "stretch"`。
- **justify**（可选）：主轴分布，取值 `"start" | "center" | "end" | "space-between"`。
- **wrap**（可选）：是否换行，布尔值。
- 最小示例：`row = Row([done, Spacer(), more], 8, "center", "space-between")`

### Grid

`Grid(columns: number, children: (Card | Row | Text | H1 | H2 | H3 | Code | Link | Pill | Spacer | Divider | Callout | Stat | UsageBar | Gauge | DiffStats | DiffView | ChangedFiles | Sources | TodoList | Table | BarChart | LineChart | PieChart | TextInput | TextArea | Checkbox | Toggle | Select | Button)[], gap?: number, align?: "start" | "center" | "end" | "stretch")`

- **必填**：`columns`、`children`。
- **columns**（必填）：列数，取值 1–6。
- **children**（必填）：可放 `Card`、`Row` 或叶子组件；`Grid` 只能直接位于 `Stack` 下。
- **gap**（可选）：子项间距，数字。
- **align**（可选）：交叉轴对齐，取值 `"start" | "center" | "end" | "stretch"`。
- 最小示例：`metrics = Grid(3, [done, blocked, onTime])`

### Spacer

`Spacer()`

- **必填**：无。
- 无参数；作为 `Row` 或 `Stack` 里的弹性空白填充。
- 最小示例：`spacer = Spacer()`

### Divider

`Divider()`

- **必填**：无。
- 无参数；渲染一条水平分隔线。
- 最小示例：`line = Divider()`

### Text

`Text(content: string | number, tone?: "primary" | "secondary" | "tertiary" | "quaternary", size?: "body" | "small", weight?: "normal" | "medium" | "semibold" | "bold", italic?: boolean, truncate?: boolean)`

- **必填**：`content`。
- **content**（必填）：文本内容，字符串或数字。
- **tone**（可选）：语气层级，取值 `"primary" | "secondary" | "tertiary" | "quaternary"`。
- **size**（可选）：字号，取值 `"body" | "small"`。
- **weight**（可选）：字重，取值 `"normal" | "medium" | "semibold" | "bold"`。
- **italic**（可选）：是否斜体，布尔值。
- **truncate**（可选）：是否截断，布尔值。
- 最小示例：`Text("已完成 12 项")`

### H1

`H1(content: string)`

- **必填**：`content`。
- **content**（必填）：一级标题文本。
- 最小示例：`H1("周报")`

### H2

`H2(content: string)`

- **必填**：`content`。
- **content**（必填）：二级标题文本。
- 最小示例：`H2("本周交付")`

### H3

`H3(content: string)`

- **必填**：`content`。
- **content**（必填）：三级标题文本。
- 最小示例：`H3("近 7 天请求量")`

### Code

`Code(content: string)`

- **必填**：`content`。
- **content**（必填）：行内代码文本；多行代码请用 Markdown 代码块。
- 最小示例：`Code("bun run precheck")`

### Link

`Link(label: string, href: string)`

- **必填**：`label`、`href`。
- **label**（必填）：链接文字。
- **href**（必填）：http(s) 地址；非 http(s) 不会渲染为链接。
- 最小示例：`Link("查看构建", "https://example.com/builds/42")`

### Pill

`Pill(label: string, size?: "sm" | "md")`

- **必填**：`label`。
- **label**（必填）：徽标文字。
- **size**（可选）：尺寸，取值 `"sm" | "md"`。
- 最小示例：`Pill("成功", "md")`

### Card

`Card(title: string, children: (Row | Text | H1 | H2 | H3 | Code | Link | Pill | Spacer | Divider | Callout | Stat | UsageBar | Gauge | DiffStats | DiffView | ChangedFiles | Sources | TodoList | Table | BarChart | LineChart | PieChart | TextInput | TextArea | Checkbox | Toggle | Select | Button)[], subtitle?: string, collapsible?: boolean, defaultOpen?: boolean)`

- **必填**：`title`、`children`。
- **title**（必填）：卡片标题。
- **children**（必填）：可放 `Row` 或叶子组件；不要嵌套 `Card`。
- **subtitle**（可选）：副标题。
- **collapsible**（可选）：是否可折叠，布尔值。
- **defaultOpen**（可选）：折叠时是否默认展开，布尔值。
- 最小示例：`card = Card("构建状态", [statusRow])`

### Callout

`Callout(tone?: "info" | "success" | "warning" | "danger" | "neutral", content: string, title?: string)`

- **必填**：`content`。
- **tone**（可选）：提示语气，取值 `"info" | "success" | "warning" | "danger" | "neutral"`；作为第一个位置参数传入。
- **content**（必填）：提示正文。
- **title**（可选）：提示标题。
- 最小示例：`Callout("warning", "磁盘剩余 8%。", "容量提醒")`

### DiffStats

`DiffStats(additions: number, deletions: number, layout?: "aligned" | "inline", showParentheses?: boolean)`

- **必填**：`additions`、`deletions`。
- **additions**（必填）：新增行数。
- **deletions**（必填）：删除行数。
- **layout**（可选）：布局，取值 `"aligned" | "inline"`，默认 `"inline"`。
- **showParentheses**（可选）：是否显示括号，布尔值。
- 最小示例：`DiffStats(128, 37)`

### DiffView

`DiffView(lines: {type: "added" | "removed" | "unchanged", content: string, lineNumber?: number}[], path?: string, language?: string, showLineNumbers?: boolean, showAccentStrip?: boolean)`

- **必填**：`lines`。
- **lines**（必填）：行数组，每项含 `type`（取值 `"added" | "removed" | "unchanged"`）、`content`、可选 `lineNumber`。
- **path**（可选）：文件路径。
- **language**（可选）：语言标记。
- **showLineNumbers**（可选）：是否显示行号，布尔值。
- **showAccentStrip**（可选）：是否显示侧边强调条，布尔值。
- 最小示例：`diff = DiffView([{ type: "added", content: "hello" }])`

### ChangedFiles

`ChangedFiles(files: {path: string, additions?: number, deletions?: number, status?: "added" | "modified" | "deleted" | "renamed"}[], title?: string, maxRows?: number)`

- **必填**：`files`。
- **files**（必填）：文件数组，每项含 `path`、可选 `additions` / `deletions` / `status`（取值 `"added" | "modified" | "deleted" | "renamed"`）。
- **title**（可选）：清单标题。
- **maxRows**（可选）：最多展示行数，取值 1–200，默认 50；路径用 `/`。
- 最小示例：`files = ChangedFiles([{ path: "src/app.ts", additions: 12, status: "modified" }])`

### Sources

`Sources(items: {title: string, url: string, snippet?: string}[], title?: string)`

- **必填**：`items`。
- **items**（必填）：1–10 项来源，每项含 `title`、`url`、可选 `snippet`；只链接不带凭据的 http(s) 地址。
- **title**（可选）：列表标题，默认 `Sources`。
- 最小示例：`Sources([{ title: "OpenUI 文档", url: "https://example.com/openui" }])`

### TodoList

`TodoList(todos: {id: string, content: string, status: "pending" | "in_progress" | "completed" | "cancelled"}[])`

- **必填**：`todos`。
- **todos**（必填）：待办数组，每项含 `id`、`content`、`status`（取值 `"pending" | "in_progress" | "completed" | "cancelled"`）。
- 最小示例：`TodoList([{ id: "t1", content: "回归历史消息", status: "pending" }])`

### Table

`Table(headers: string[], rows: (string | number)[][], columnAlign?: "left" | "center" | "right"[], rowTone?: "success" | "danger" | "warning" | "info" | "neutral"[], striped?: boolean, framed?: boolean, emptyMessage?: string)`

- **必填**：`headers`、`rows`。
- **headers**（必填）：列名数组。
- **rows**（必填）：二维数组，单元格只放字符串或数字；行按 `headers` 长度截断或补齐。
- **columnAlign**（可选）：每列对齐，取值 `"left" | "center" | "right"` 的数组。
- **rowTone**（可选）：每行语气，取值 `"success" | "danger" | "warning" | "info" | "neutral"` 的数组。
- **striped**（可选）：是否斑马纹，布尔值。
- **framed**（可选）：是否显示外框，布尔值。
- **emptyMessage**（可选）：无数据时的提示文案。
- 最小示例：`Table(["城市", "订单量"], [["上海", 1284]])`

### Stat

`Stat(value: string | number, label: string, tone?: "success" | "danger" | "warning" | "info")`

- **必填**：`value`、`label`。
- **value**（必填）：指标值，字符串或数字。
- **label**（必填）：指标名称。
- **tone**（可选）：语气，取值 `"success" | "danger" | "warning" | "info"`。
- 最小示例：`Stat("12", "已完成任务", "success")`

### UsageBar

`UsageBar(segments: {id: string, value: number, color?: "gray" | "purple" | "green" | "yellow" | "cyan" | "pink" | "blue" | "orange" | "red"}[], total: number, topLeftLabel?: string, topRightLabel?: string)`

- **必填**：`segments`、`total`。
- **segments**（必填）：分段数组，每项含 `id`、`value`、可选 `color`（取值 `"gray" | "purple" | "green" | "yellow" | "cyan" | "pink" | "blue" | "orange" | "red"`）。
- **total**（必填）：总量，数字。
- **topLeftLabel**（可选）：左上角标签。
- **topRightLabel**（可选）：右上角标签。
- 最小示例：`UsageBar([{ id: "used", value: 72, color: "blue" }], 100)`

### Gauge

`Gauge(value: number, label: string, max?: number, unit?: string, detail?: string, tone?: "success" | "danger" | "warning" | "info", size?: number)`

- **必填**：`value`、`label`。
- **value**（必填）：当前值，数字。
- **label**（必填）：指标名称。
- **max**（可选）：上限，默认 100，必须大于 0。
- **unit**（可选）：单位。
- **detail**（可选）：补充说明。
- **tone**（可选）：语气，取值 `"success" | "danger" | "warning" | "info"`。
- **size**（可选）：尺寸，取值 72–160，默认 96。
- 最小示例：`Gauge(72, "上下文用量", 100, "%", "144k / 200k tokens")`

### BarChart

`BarChart(categories: string[], series: {name: string, data: number[], tone?: "success" | "danger" | "warning" | "info" | "neutral"}[], height?: number, stacked?: boolean, horizontal?: boolean, normalized?: boolean, valuePrefix?: string, valueSuffix?: string, showValues?: boolean)`

- **必填**：`categories`、`series`。
- **categories**（必填）：分类标签数组。
- **series**（必填）：序列数组，每项含 `name`、`data`、可选 `tone`（取值 `"success" | "danger" | "warning" | "info" | "neutral"`）；每个 `data` 长度必须等于 `categories` 长度。
- **height**（可选）：高度，取值 120–600。
- **stacked**（可选）：是否堆叠，布尔值。
- **horizontal**（可选）：是否横向，布尔值。
- **normalized**（可选）：是否归一化，布尔值。
- **valuePrefix**（可选）：数值前缀。
- **valueSuffix**（可选）：数值后缀。
- **showValues**（可选）：是否显示数值，布尔值。
- 最小示例：`BarChart(["渲染", "回传"], [{ name: "缺陷", data: [3, 1] }])`

### LineChart

`LineChart(categories: string[], series: {name: string, data: number[], tone?: "success" | "danger" | "warning" | "info" | "neutral"}[], height?: number, fill?: boolean, valuePrefix?: string, valueSuffix?: string, showValues?: boolean)`

- **必填**：`categories`、`series`。
- **categories**（必填）：分类标签数组。
- **series**（必填）：序列数组，每项含 `name`、`data`、可选 `tone`（取值 `"success" | "danger" | "warning" | "info" | "neutral"`）；每个 `data` 长度必须等于 `categories` 长度。
- **height**（可选）：高度，取值 120–600。
- **fill**（可选）：是否填充面积，布尔值。
- **valuePrefix**（可选）：数值前缀。
- **valueSuffix**（可选）：数值后缀。
- **showValues**（可选）：是否显示数值，布尔值。
- 最小示例：`LineChart(["周一", "周二"], [{ name: "请求", data: [120, 160] }])`

### PieChart

`PieChart(data: {label: string, value: number, tone?: "success" | "danger" | "warning" | "info" | "neutral"}[], size?: number, donut?: boolean)`

- **必填**：`data`。
- **data**（必填）：切片数组，每项含 `label`、`value`、可选 `tone`（取值 `"success" | "danger" | "warning" | "info" | "neutral"`）；非有限数值会被丢弃。
- **size**（可选）：尺寸，取值 100–400。
- **donut**（可选）：是否环形图，布尔值。
- 最小示例：`PieChart([{ label: "完成", value: 82, tone: "success" }])`

### TextInput

`TextInput(name: string, label?: string, placeholder?: string, type?: "text" | "email" | "url" | "search" | "number", defaultValue?: string)`

- **必填**：`name`。
- **name**（必填）：表单字段名，提交时用。
- **label**（可选）：字段标签。
- **placeholder**（可选）：占位提示。
- **type**（可选）：输入类型，取值 `"text" | "email" | "url" | "search" | "number"`。
- **defaultValue**（可选）：默认值。
- 最小示例：`TextInput("version", "版本号", "例如 2026.10.29-1")`

### TextArea

`TextArea(name: string, label?: string, placeholder?: string, rows?: number, defaultValue?: string)`

- **必填**：`name`。
- **name**（必填）：表单字段名，提交时用。
- **label**（可选）：字段标签。
- **placeholder**（可选）：占位提示。
- **rows**（可选）：行数。
- **defaultValue**（可选）：默认值。
- 最小示例：`TextArea("note", "发布说明", "本次改动内容", 3)`

### Checkbox

`Checkbox(name: string, label: string, defaultValue?: boolean)`

- **必填**：`name`、`label`。
- **name**（必填）：表单字段名，提交时用。
- **label**（必填）：复选框文字。
- **defaultValue**（可选）：是否默认勾选。
- 最小示例：`Checkbox("notify", "完成后通知我", true)`

### Toggle

`Toggle(name: string, label?: string, defaultValue?: boolean)`

- **必填**：`name`。
- **name**（必填）：表单字段名，提交时用。
- **label**（可选）：开关文字。
- **defaultValue**（可选）：是否默认开启。
- 最小示例：`Toggle("urgent", "加急发布", false)`

### Select

`Select(name: string, options: {value: string, label: string}[], label?: string, placeholder?: string, defaultValue?: string)`

- **必填**：`name`、`options`。
- **name**（必填）：表单字段名，提交时用。
- **options**（必填）：选项数组，每项含 `value` 与 `label`。
- **label**（可选）：字段标签。
- **placeholder**（可选）：占位提示。
- **defaultValue**（可选）：默认选中值。
- 最小示例：`Select("environment", [{ value: "staging", label: "预发" }], "目标环境")`

### Button

`Button(label: string, action: ActionExpression, variant?: "primary" | "secondary" | "ghost", disabled?: boolean)`

- **必填**：`label`、`action`。
- **label**（必填）：按钮文字。
- **action**（必填）：`@ToAssistant("...")` 提交给助手，或 `@OpenUrl("...")` 打开 http(s) 链接；多个步骤用 `Action([...])`。
- **variant**（可选）：按钮样式，取值 `"primary" | "secondary" | "ghost"`。
- **disabled**（可选）：是否禁用，布尔值。
- 最小示例：`Button("继续分析", @ToAssistant("继续分析这张图"), "secondary")`
