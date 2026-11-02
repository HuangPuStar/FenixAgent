# OpenUI 完整示例

<!--
  同步测试（packages/ui-components/web/__tests__/openui-skill-doc-sync.test.ts）依赖以下约定：
  · 每个 ```openui 围栏都是可直接渲染的完整程序，第一条语句必须是 `root = Stack(`；
  · 围栏内出现的组件名必须属于 `@peri-code/sdk` spec.json 的 32 个组件；
  · 除 root 外每个变量都必须被引用，否则测试失败。
  逐组件参数与约束见 references/catalog.md。
-->

## 示例 1：结论 + 指标（Stack + Grid + Stat）

```openui
root = Stack([headline, metrics, basis])
headline = H2("本周华东区处理量上升 12%")
metrics = Grid(3, [orders, refunds, onTime])
orders = Stat("2,702", "订单量", "success")
refunds = Stat("34", "退款单", "warning")
onTime = Stat("96.4%", "准时率", "info")
basis = Text("来源：订单库，2026-10-20 至 2026-10-26；对比前 7 天。", "secondary", "small")
```

先给结论，再用三个指标支撑；来源与口径用 `Text` 的 `secondary` + `small` 弱化。

## 示例 2：明细对照（Table）

```openui
root = Stack([title, table, note])
title = H2("各城市订单与退款")
table = Table(["城市", "订单量", "退款单数", "退款率"], [["上海", 1284, 15, "1.2%"], ["杭州", 906, 7, "0.8%"], ["南京", 512, 12, "2.3%"]], ["left", "right", "right", "right"])
note = Text("退款率最低的是杭州；南京需要复查退款原因。", "secondary", "small")
```

同构记录用一张 `Table`；数字列右对齐，来源与结论放在表格前后，不塞进单元格。

## 示例 3：趋势与对比（LineChart + BarChart）

```openui
root = Stack([lineTitle, line, barTitle, bar, note])
lineTitle = H3("近 7 天请求量")
line = LineChart(["周一", "周二", "周三", "周四", "周五", "周六", "周日"], [{ name: "请求量", data: [120, 160, 140, 200, 180, 240, 220], tone: "info" }], 220, true, "", " 次")
barTitle = H3("各模块缺陷数")
bar = BarChart(["渲染", "回传", "鉴权", "存储"], [{ name: "阻塞", data: [3, 1, 0, 2], tone: "danger" }, { name: "一般", data: [8, 5, 4, 6], tone: "warning" }], 240, true)
note = Text("周六请求量最高，较周均高 31%。", "secondary", "small")
```

每个 `series.data` 的长度必须与 `categories` 一致；缩写说明与结论写在图外。

## 示例 4：任务清单（TodoList）

```openui
root = Stack([title, todos])
title = H3("本周发布清单")
todos = TodoList([{ id: "t1", content: "合并 OpenUI 替换分支", status: "completed" }, { id: "t2", content: "补齐内置技能文档", status: "in_progress" }, { id: "t3", content: "回归历史消息渲染", status: "pending" }])
```

`status` 只用 `pending` / `in_progress` / `completed` / `cancelled` 四态；`id` 在一条程序内唯一。

## 示例 5：改动概览（DiffStats + DiffView + ChangedFiles）

```openui
root = Stack([title, stats, diff, files, note])
title = H3("本次改动")
stats = DiffStats(128, 37)
diff = DiffView([{ type: "removed", content: "language: \"ui-spec\"" }, { type: "added", content: "language: \"openui\"" }], "docs/arch/27-agent-output-visualization.md", "markdown", true, true)
files = ChangedFiles([{ path: "packages/ui-components/web/chat/primitives/message-plugins.ts", additions: 96, deletions: 18, status: "modified" }, { path: ".agents/skills/openui/SKILL.md", additions: 210, status: "added" }], "改动文件", 20)
note = Callout("info", "Diff 视图只读展示，不提供编辑入口。", "说明")
```

`DiffView.lines` 的 `type` 只有 `added` / `removed` / `unchanged`；字符串里的双引号用反斜杠转义。

## 示例 6：来源列表（Sources）

```openui
root = Stack([title, sources, note])
title = H3("参考资料")
sources = Sources([{ title: "OpenUI Lang 文档", url: "https://example.com/openui", snippet: "程序语法与组件目录" }, { title: "Peri SDK 说明", url: "https://example.com/peri-sdk" }], "来源")
note = Text("链接仅为示例；只有不带凭据的 http(s) 地址会被渲染为链接。", "secondary", "small")
```

`Sources` 收 1–10 项；不要放内网地址、带用户名密码的 URL 或非 http(s) 协议。

## 示例 7：表单与提交（Card + 表单字段 + Button）

```openui
root = Stack([card])
card = Card("创建发布单", [envSelect, versionInput, noteInput, urgentToggle, actions], "填写后提交给助手", true, true)
envSelect = Select("environment", [{ value: "staging", label: "预发" }, { value: "prod", label: "生产" }], "目标环境", "请选择环境", "staging")
versionInput = TextInput("version", "版本号", "例如 2026.10.29-1", "text")
noteInput = TextArea("note", "发布说明", "本次改动内容", 3)
urgentToggle = Toggle("urgent", "加急发布", false)
actions = Row([submit], 8, "end", "end")
submit = Button("提交发布单", @ToAssistant("请按表单内容创建发布单"), "primary")
```

表单字段靠 `name` 绑定；值不会自动进入对话，必须在同一 `Card` 内放 `@ToAssistant` 提交按钮。

## 示例 8：状态卡与提示（Card + Callout）

```openui
root = Stack([statusCard, nextStep])
statusCard = Card("构建状态", [statusRow, line, detail], "预发环境 · 2026-10-29", true, true)
statusRow = Row([pill, spacer, time], 8, "center", "space-between")
pill = Pill("成功", "md")
spacer = Spacer()
time = Text("14:32", "secondary", "small")
line = Divider()
detail = Text("镜像已推送，健康检查通过。", "primary", "body")
nextStep = Callout("success", "可以进入人工发布审批。", "下一步")
```

`Card` 的子项可以是 `Row` 或叶子；`Row` 里只能放叶子，用 `Spacer` 推开两端。
