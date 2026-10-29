---
name: openui
description: 当指标、对照、图表、状态卡、Todo 或小型表单明显优于散文时，用 OpenUI Lang 输出恰好一个完整 openui 围栏程序；代码、命令、路径与普通列表仍用 Markdown。
source: meta-builtin
---

# OpenUI 输出契约

OpenUI Lang 是一行一条语句的声明式程序，宿主用 `@peri-code/sdk` 的 OpenUI 渲染器把它变成界面。**你编排信息，SDK 负责渲染与样式**。

## 什么时候用

默认用普通 Markdown 回答。只有当中文散文明显不如结构化呈现时，才输出 OpenUI：

- 指标：几个关键数字与变化（`Stat` / `Grid`）。
- 对照：同构记录的多列比较（`Table`）。
- 图表：趋势、构成、分组对比（`LineChart` / `BarChart` / `PieChart`）。
- 状态：发布、构建、任务收尾的结论与风险（`Card` / `Callout`）。
- Todo：有状态的任务清单（`TodoList`）。
- 小型表单：两三个字段的输入并提交（表单字段 + `Button`）。
- 改动：Diff、改动文件清单（`DiffStats` / `DiffView` / `ChangedFiles`）。

以下情况**不要**用 OpenUI，继续用 Markdown：

- 代码、命令、路径、配置片段、日志。
- 普通列表、步骤说明、长文解释。
- 数据不全、口径不明、需要大量文字论证。
- 拿不准时。

一次回复最多输出**一个**完整的 ` ```openui ` 围栏；围栏外可以写解释，围栏内只有 OpenUI Lang。

## 语法规则

1. 每行一条语句：`identifier = Expression`。
2. 第一行必须是 `root = Stack([...])`，让流式渲染先出现外壳。
3. 参数是**位置参数**：`Row([a, b], 8, "end", "end")`。不能写命名参数（`gap: 8` 这种冒号语法会静默失效）。
4. 字符串用双引号，反斜杠转义；数字、布尔、数组、对象直接写字面量。
5. 除 `root` 外，每个变量必须被至少一处引用；否则会被静默丢弃、不会渲染。
6. 组件可以内联，也可以先定义再引用；推荐引用，流式填充更自然。
7. 整个程序必须完整、独立，不能是补丁、片段或「只写改动部分」。
8. 用户要求看 OpenUI 源码时，用 `text` 围栏，不要用 `openui` 围栏。

## 组件目录

以下 32 个组件是全部可用集合。未列出的组件名不存在。

### 布局与文本

- `Stack(children: (Grid | Card | Row | Text | H1 | H2 | H3 | Code | Link | Pill | Spacer | Divider | Callout | Stat | UsageBar | Gauge | DiffStats | DiffView | ChangedFiles | Sources | TodoList | Table | BarChart | LineChart | PieChart | TextInput | TextArea | Checkbox | Toggle | Select | Button)[], gap?: number)` — 纵向页面根，唯一允许的 `root`。
- `Row(children: (Text | H1 | H2 | H3 | Code | Link | Pill | Spacer | Divider | Callout | Stat | UsageBar | Gauge | DiffStats | DiffView | ChangedFiles | Sources | TodoList | Table | BarChart | LineChart | PieChart | TextInput | TextArea | Checkbox | Toggle | Select | Button)[], gap?: number, align?: "start" | "center" | "end" | "stretch", justify?: "start" | "center" | "end" | "space-between", wrap?: boolean)` — 横向布局，子项只能是叶子组件。
- `Grid(columns: number, children: (Card | Row | Text | H1 | H2 | H3 | Code | Link | Pill | Spacer | Divider | Callout | Stat | UsageBar | Gauge | DiffStats | DiffView | ChangedFiles | Sources | TodoList | Table | BarChart | LineChart | PieChart | TextInput | TextArea | Checkbox | Toggle | Select | Button)[], gap?: number, align?: "start" | "center" | "end" | "stretch")` — N 列网格，只能直接位于 `Stack` 下。
- `Spacer()` — 弹性的空白填充，用于 `Row` 或 `Stack`。
- `Divider()` — 水平分隔线。
- `Text(content: string | number, tone?: "primary" | "secondary" | "tertiary" | "quaternary", size?: "body" | "small", weight?: "normal" | "medium" | "semibold" | "bold", italic?: boolean, truncate?: boolean)` — 正文文本。
- `H1(content: string)` — 一级标题。
- `H2(content: string)` — 二级标题。
- `H3(content: string)` — 三级标题。
- `Code(content: string)` — 行内代码；多行代码用 Markdown 代码块。
- `Link(label: string, href: string)` — 外链；仅 http(s) 地址会渲染为链接。
- `Pill(label: string, size?: "sm" | "md")` — 紧凑的状态或标签徽标。

### 容器与数据

- `Card(title: string, children: (Row | Text | H1 | H2 | H3 | Code | Link | Pill | Spacer | Divider | Callout | Stat | UsageBar | Gauge | DiffStats | DiffView | ChangedFiles | Sources | TodoList | Table | BarChart | LineChart | PieChart | TextInput | TextArea | Checkbox | Toggle | Select | Button)[], subtitle?: string, collapsible?: boolean, defaultOpen?: boolean)` — 带标题的卡片，可折叠。
- `Callout(tone?: "info" | "success" | "warning" | "danger" | "neutral", content: string, title?: string)` — 强调提示框。
- `DiffStats(additions: number, deletions: number, layout?: "aligned" | "inline", showParentheses?: boolean)` — 增删行数。
- `DiffView(lines: {type: "added" | "removed" | "unchanged", content: string, lineNumber?: number}[], path?: string, language?: string, showLineNumbers?: boolean, showAccentStrip?: boolean)` — 统一 Diff 视图。
- `ChangedFiles(files: {path: string, additions?: number, deletions?: number, status?: "added" | "modified" | "deleted" | "renamed"}[], title?: string, maxRows?: number)` — 改动文件清单。
- `Sources(items: {title: string, url: string, snippet?: string}[], title?: string)` — 有序来源列表（1–10 项）。
- `TodoList(todos: {id: string, content: string, status: "pending" | "in_progress" | "completed" | "cancelled"}[])` — 紧凑 Todo 列表。
- `Table(headers: string[], rows: (string | number)[][], columnAlign?: "left" | "center" | "right"[], rowTone?: "success" | "danger" | "warning" | "info" | "neutral"[], striped?: boolean, framed?: boolean, emptyMessage?: string)` — 数据表格，行是二维数组。

### 指标与图表

- `Stat(value: string | number, label: string, tone?: "success" | "danger" | "warning" | "info")` — 单个指标。
- `UsageBar(segments: {id: string, value: number, color?: "gray" | "purple" | "green" | "yellow" | "cyan" | "pink" | "blue" | "orange" | "red"}[], total: number, topLeftLabel?: string, topRightLabel?: string)` — 分段用量条。
- `Gauge(value: number, label: string, max?: number, unit?: string, detail?: string, tone?: "success" | "danger" | "warning" | "info", size?: number)` — 单值环形仪表。
- `BarChart(categories: string[], series: {name: string, data: number[], tone?: "success" | "danger" | "warning" | "info" | "neutral"}[], height?: number, stacked?: boolean, horizontal?: boolean, normalized?: boolean, valuePrefix?: string, valueSuffix?: string, showValues?: boolean)` — 柱状图。
- `LineChart(categories: string[], series: {name: string, data: number[], tone?: "success" | "danger" | "warning" | "info" | "neutral"}[], height?: number, fill?: boolean, valuePrefix?: string, valueSuffix?: string, showValues?: boolean)` — 折线图。
- `PieChart(data: {label: string, value: number, tone?: "success" | "danger" | "warning" | "info" | "neutral"}[], size?: number, donut?: boolean)` — 饼图或环形图。

### 表单与动作

- `TextInput(name: string, label?: string, placeholder?: string, type?: "text" | "email" | "url" | "search" | "number", defaultValue?: string)` — 单行输入，绑定表单字段。
- `TextArea(name: string, label?: string, placeholder?: string, rows?: number, defaultValue?: string)` — 多行输入，绑定表单字段。
- `Checkbox(name: string, label: string, defaultValue?: boolean)` — 复选框，绑定表单字段。
- `Toggle(name: string, label?: string, defaultValue?: boolean)` — 开关，绑定表单字段。
- `Select(name: string, options: {value: string, label: string}[], label?: string, placeholder?: string, defaultValue?: string)` — 下拉框，绑定表单字段。
- `Button(label: string, action: ActionExpression, variant?: "primary" | "secondary" | "ghost", disabled?: boolean)` — 动作按钮。

## 动作

`Button` 的 `action` 有两种宿主动作：

- `@ToAssistant("...")`：把这条消息发送给助手。表单提交用它；按钮所在卡片里的字段值由宿主随动作发送。
- `@OpenUrl("...")`：打开 http(s) 链接；非 http(s) 地址不会执行。

表单字段用 `name` 绑定，值由宿主收集：

- 用户输入的表单值**不会自动出现在对话里**，必须在同一 `Card` 内放一个 `Button(..., @ToAssistant("..."))` 提交。
- 表单值随用户消息发送，由模型按消息内容解释；它不是宿主状态，也不是授权凭据。
- `Button` 不带 action 时，点击等价于 `@ToAssistant(label)`。

## 布局与数据约束

- 只有 `Stack` / `Row` / `Grid` / `Card` 接受 `children`；其余组件都是叶子。
- `Stack` 是唯一允许作为 `root` 的组件；`root` 必须出现在第一行。
- `Grid` 只能直接位于 `Stack` 下。
- `Row` 的子项只能是叶子组件，不能放 `Card` 或 `Grid`。
- `Card` 的子项可以是 `Row` 或叶子；不要嵌套 `Card`。
- `Card` / `Row` / `Grid` 的 `children` 是位置参数里的第一个（`Grid` 是第二个，前面是 `columns`）。
- `Table` 的 `rows` 是二维数组，每行长度按 `headers` 截断或补齐；单元格只放字符串或数字。
- 图表的每个 `series.data` 长度必须等于 `categories` 长度，否则显示警告而不是图。
- `Sources` 收 1–10 项；`url` 只接受不带凭据的 http(s) 地址。
- `Gauge` 的 `max` 必须大于 0；`size` 取值 72–160。
- `ChangedFiles` 的路径用 `/`；`maxRows` 取值 1–200。
- `UsageBar` 的 `segments[].color` 只能取目录列出的 9 种颜色。

## 常见错误

| 写法 | 后果与改法 |
| --- | --- |
| 写命名参数：`Row([a, b], gap: 8)` | 冒号不是语法，参数失效；按位置顺序写 |
| 定义了变量却没引用 | 变量被静默丢弃；把它放进父节点的 `children` |
| 输出多个 `openui` 围栏 | 多条围栏整体回退 Markdown；只保留一个 |
| `root` 不是 `Stack` | 无法渲染；第一行固定 `root = Stack([...])` |
| 在围栏内写解释文字 | 解析失败；解释移到围栏外 |
| 用 OpenUI 展示代码或命令 | 不该用；保留 Markdown 代码块 |
| 引用不存在的组件名 | 解析失败；只用目录里的 32 个组件 |
| 图表数据长度与分类不一致 | 图表降级为警告；逐项对齐后再输出 |
| 把表单字段放着不提交 | 用户输入丢失；在同一 `Card` 内放 `@ToAssistant` 按钮 |
| 中段省略可选参数 | 位置参数不能跳写；省略只能从末尾开始 |

## 自检清单

输出前逐条确认：

1. 第一行是 `root = Stack([...])`。
2. 除 `root` 外每个变量都被引用，所有引用都有定义。
3. 没有命名参数，参数顺序与目录一致。
4. 组件名、枚举值都来自本目录。
5. 只有一个 ` ```openui ` 围栏，围栏外才有解释文字。
6. 图表的 `series.data` 与 `categories` 等长，表格行是二维数组。
7. 表单字段旁有 `@ToAssistant` 按钮，链接只用 http(s)。
8. 代码、命令、路径没有塞进 OpenUI。

按需详查：`references/catalog.md`（逐组件参数与约束）、`references/examples.md`（完整示例）；不是生成前置依赖。
