---
name: ui-spec
description: 用 Stack、Text、Table 编排结论、指标与对照；输出一个完整 ui-spec JSON 围栏，拿不准用普通文字。
---

# 声明式 UI 输出契约（ui-spec）

在助手消息中输出 `ui-spec` 围栏；宿主严格校验后用自有 React 组件渲染。**你编排信息，宿主负责样式**。

用于已有数据的摘要、清单、对照。数据不全、口径不明或目录外需求用普通文字；日志/命令/代码用普通代码块。无数据说明「暂无数据」，不渲染空状态。

## 可用类型（切片 1 的全部）

唯一真相：`packages/ui-components/web/chat/ui-spec/catalog.ts`（`zod/v4`）。完整 props 如下，未列字段禁止；长度按 UTF-16 code unit 计。

- `Stack` — 纵向容器。props 无必填；可选 `gap`：`"sm" | "md" | "lg"`，默认 `"md"`。仅它可带非空 `children`，不能横排。
- `Text` — 叶子文本。必填 `text`：字符串，1–2000 字符；可选 `tone`：`"default" | "muted" | "danger"`，省略为 `"default"`。
- `Table` — 叶子明细表。必填 `columns`：字符串数组，1–8 列，每列 1–80 字符；必填 `rows`：字符串二维数组，1–50 行，每行 1–8 格，每格 0–500 字符。可选 `caption`：字符串，0–200 字符；可选 `align`：1–8 项数组，每项 `"left" | "right"`，默认全 `"left"`。**每行格数及 align 项数须等于 columns 列数**；数值也写字符串。

**黑名单：切片 1 只有这三个类型。** `Chart`、`Kpi`、`Grid`、`Heading`、`Link`、`Image`、`Progress`、`Timeline`、`Diff` 等都不存在——写出来只会渲染成「不支持的组件类型」占位，不要尝试。**类型只增不改，将来新增的类型会补进本文档。** 未来若新增图表，仍须标注坐标轴与单位，当前不要输出图表。

## 输出与安全硬约束

- **一次输出一个完整的围栏**：开标记为三个反引号紧接 `ui-spec`（大小写敏感），闭标记为三个反引号，各占一行。内含完整 JSON，外可加解释；不拆片、不输出多个围栏。
- 顶层必填且仅有 `version`、`root`、`elements`；`version` 为 `1`，`elements` 为 id → 元素的扁平对象。
- 元素仅有必填 `type`、可选对象 `props`（默认 `{}`）、可选 id 数组 `children`（默认 `[]`）；必填 props 不可省。`children` 与 `props` 同级，不放对象。`Text` / `Table` 省略 children（空数组也合法）。
- root 与引用必须存在，全部元素从 root 可达；树而非 DAG：禁止重复引用、多父共享、环。复用文案须新建 id。禁止重复 JSON 键，后值会覆盖前值。
- 全局限额：正文 ≤64000 字符（含渲染器附加换行，留余量）；元素 1–200；树深度 ≤12（root 为 1），props 对象/数组嵌套 ≤12；children ≤40；root/id/type 长度 1–80；props 任意字符串键/值 ≤2000。
- **只产数据、数据内联**：不写代码（JS/HTML/CSS）、表达式、`$` / `{{ }}` 绑定；不引用 URL、图片、iframe。组件不发请求、不执行 `fetch`。字符串一律是文本节点，不解析 Markdown，不允许 HTML 注入。
- 环境上下文（`envId` 等）只能由宿主注入，不能从 Spec 读取或覆盖。禁止 `style`、`className`、颜色、字号、宽度、事件。
- 非法或超限一律降级：JSON/结构/版本错误、全局超限整块降级；props 非法、组件专属超限为 `invalid-props` 占位；未知类型为 `unsupported` 占位。不静默截断，占位不渲染子树，兄弟继续，消息不崩溃。

## 用三种组件做出阅读层级

先定读者需要的结论，再编排：**结论 → 证据 → 明细 → 口径**。

- **节奏**：外层 `Stack` 用 `lg` 分主题，内层 `sm` 聚合相关内容，普通段落 `md`。推荐两层分组；不承诺边框或标题字号。
- **摘要块**：首个 `Text` 给结论，随后 2–3 条证据。正文 `default`，来源/时间/脚注 `muted`，异常才用 `danger`，风险不只靠颜色。
- **指标式文本**：少量关键数写「标签：数值 单位；基准/变化」，用 `sm` 聚合短句；不模拟大号数字。未知写「未知」，不编数字、不用空格排版。
- **表格还是文本**：同构记录、同维度对比用 `Table`，不堆同构卡片；异构结论/风险/解释用 `Text` + `Stack`，不把长段落塞表格。
- **对比与脚注**：列名含单位；名称左对齐，数值右对齐。优先 2–5 个关键列；已知来源与时间范围写 `caption` 或 muted 文本。超限先概括并说明筛选范围，不伪装完整结果。

### 范式 A：一句话结论（Text）

以下示例独立合法；实际回答选用或组合，替换为真实数据，仍只输出一个围栏。

```ui-spec
{"version":1,"root":"result","elements":{"result":{"type":"Text","props":{"text":"预发 12 项检查通过，可进入人工发布审批。"}}}}
```

### 范式 B：指标式文本 + 分组节奏 + 风险清单

```ui-spec
{
  "version": 1, "root": "report", "elements": {
    "report": {"type":"Stack","props":{"gap":"lg"},"children":["headline","metrics","risk"]},
    "headline": {"type":"Text","props":{"text":"结论：处理量上升，退款仍需关注。"}},
    "metrics": {"type":"Stack","props":{"gap":"sm"},"children":["orders","refunds","basis"]},
    "orders": {"type":"Text","props":{"text":"订单：128 单；上周 100 单，增加 28 单。"}},
    "refunds": {"type":"Text","props":{"text":"退款：9 单；与上周持平。"}},
    "basis": {"type":"Text","props":{"text":"来源：订单周报，2026-10-01 至 10-07；对比前 7 天。","tone":"muted"}},
    "risk": {"type":"Text","props":{"text":"风险：退款原因未归类，不能判断质量改善。","tone":"danger"}}
  }
}
```

### 范式 C：结论 + 对比清单（Table）

```ui-spec
{
  "version": 1, "root": "compare", "elements": {
    "compare": {"type":"Stack","children":["decision","details"]},
    "decision": {"type":"Text","props":{"text":"结论：同批 1000 条记录，B 更快且失败更少。"}},
    "details": {"type":"Table","props":{
      "caption":"来源：2026-10-07 单轮测试；不外推稳定性。",
      "columns":["方案","耗时（秒）","失败（条）"],
      "rows":[["A","42","3"],["B","31","1"]],
      "align":["left","right","right"]
    }}
  }
}
```

## 反面写法与后果（不要照抄）

| 常见错误 | 后果与改法 |
| --- | --- |
| 给顶层或元素加 `title`；children 内嵌对象；叶节点挂子节点 | 整块结构降级；标题用 Text，子节点放 elements 并引用 id |
| 引用不存在的 id、共享同一脚注 id、留孤立元素 | 整块结构降级；每个非 root 节点恰有一个父引用 |
| 在 props 加 `style` / `className`，把 children 塞进 props | 该元素 invalid-props；删除额外字段，children 与 props 同级 |
| tone 写 `success`，align 写 `center`，单元格放数字或对象 | 该元素 invalid-props；仅用清单枚举，单元格用字符串 |
| rows 为空、缺列、多列、align 长度不齐 | 该表 invalid-props；无数据用文字，有数据逐行对齐 |
| 文本里写 `**加粗**` 或 `<b>标题</b>` | 原样文本，不会加粗；用顺序、短句、间距和 tone 建层级 |
| JSON 注释、尾逗号、半截输出 | 整块降级；交付完整严格 JSON 和闭合围栏 |

自检：类型/字段/枚举合法 → 引用成树 → 行列/align 等长且格值为字符串 → 限额内 → 结论与口径明确 → 围栏完整。

按需详查：`references/catalog.md`（schema/边界）、`references/examples.md`（正反例）；不是生成前置依赖。
