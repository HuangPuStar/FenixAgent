# ui-spec 类型目录（切片 1）

<!--
  本文档是 `packages/ui-components/web/chat/ui-spec/catalog.ts` 的 schema 与边界详解；SKILL.md 已内联完整类型清单。
  两者由 packages/ui-components/web/__tests__/ui-spec-catalog-doc-sync.test.ts 双向钉住：改代码必须改这里，改这里必须改代码。

  同步测试依赖以下格式契约，改格式前先看测试：
  · `### ` 三级标题只用于类型，标题文本就是类型名，每个类型恰好出现一次（重复标题即失败）；
    其它小节一律用 `## `，且全文标题不得重名。测试按这两个方向比较集合，不做子串查找。
  · 每个类型段内有且仅有一个 ```json 围栏，内容是该类型 props 的 JSON Schema，由 catalog.ts 的 zod schema
    经 `z.toJSONSchema` 导出，省略 `$schema` 键（测试忽略它并做逐字段深比较）。
  · 每个类型段内的 `- **必填**：` 行列出全部必填字段（无则写 `无`），测试用它比对 schema 的 required。
-->

## 顶层结构

```json
{
  "version": 1,
  "root": "root",
  "elements": {
    "root": { "type": "Text", "props": { "text": "一句话" } }
  }
}
```

- `version`：目前只接受 `1`；其它整数整块降级为原文，并提示版本不支持。
- `root`：入口元素的 id，必须存在于 `elements` 中。
- `elements`：id → 元素 的扁平表。元素只有 `type`、`props`、`children` 三个字段，多写一个字段整块降级为原文。
- 每个元素都要能从 `root` 走到；同一个元素只能出现在一个父元素的 `children` 里；引用不能成环。
- `Text` 与 `Table` 是叶子节点，生成时省略 `children`（校验也接受空数组，非空则整块降级）。

## 全局限额

| 常量 | 含义 | 上限 |
| --- | --- | --- |
| `maxCodeChars` | 单个 `ui-spec` 围栏正文字符数（UTF-16 code unit，围栏末尾的换行也算在内） | 64000 |
| `maxElements` | `elements` 的条目数 | 200 |
| `maxDepth` | 树深度（`root` 记 1）；props 对象/数组嵌套深度也复用此限额 | 12 |
| `maxChildren` | 单个元素 `children` 的元素个数 | 40 |
| `maxString` | props 中任意字符串键或值的长度 | 2000 |
| `maxIdChars` | `root` 与元素 id（`elements` 的键）长度 | 80 |
| `maxTypeChars` | 元素 `type` 长度 | 80 |
| `maxTableRows` | `Table.rows` 的行数 | 50 |
| `maxTableCols` | `Table.columns`、每行单元格数、`align` 的长度 | 8 |

全局超限整块降级为原文；`maxTableRows` / `maxTableCols` 是目录级约束，超限为该表 `invalid-props` 占位。caption、列名、单元格的专属长度超限同样按元素处理，但若先触发全局字符串上限则整块降级。均不静默截断成貌似完整的 UI。

## 跨字段约束

字段本身合法、组合起来不合法时，按元素处理：该元素显示为无效占位，它的兄弟元素继续渲染。

| 规则 ID | 约束 | 违反时结果 |
| --- | --- | --- |
| CT-1 | `Table`：`rows` 的每一行长度必须等于 `columns` 的长度，不能缺列或多列 | 该元素 `invalid-props` 占位 |
| CT-2 | `Table`：`align` 出现时长度必须等于 `columns` 的长度 | 该元素 `invalid-props` 占位 |
| CT-3 | 省略取默认值：`Stack.gap` 省略按 `md`，`Text.tone` 省略按 `default`，`Table.align` 省略按全部左对齐 | 不是错误，按默认值渲染 |

## 类型

### Stack

容器：只做分组与间距，用 `children` 编排子元素。

- **必填**：无。
- **`gap`**（可选）：子元素间距，取值 `"sm" | "md" | "lg"`；省略按 `"md"`。
- **`children`**（可选）：子元素 id 数组。重复引用同一个元素、一个元素被两个父元素引用、引用成环，都会整块降级。
- props 的 JSON Schema：

```json
{
  "type": "object",
  "properties": {
    "gap": { "type": "string", "enum": ["sm", "md", "lg"] }
  },
  "additionalProperties": false
}
```

### Text

一段只读文字。叶子节点：不要写 `children`。

- **必填**：`text`。
- **`text`**（必填）：1–2000 字符，不能是空串。
- **`tone`**（可选）：取值 `"default" | "muted" | "danger"`；省略按 `"default"`。来源、时间范围、补充口径这类次要信息用 `"muted"`，异常与失败用 `"danger"`。
- props 的 JSON Schema：

```json
{
  "type": "object",
  "properties": {
    "text": { "type": "string", "minLength": 1, "maxLength": 2000 },
    "tone": { "type": "string", "enum": ["default", "muted", "danger"] }
  },
  "required": ["text"],
  "additionalProperties": false
}
```

### Table

只读明细表。叶子节点：不要写 `children`。

- **必填**：`columns`、`rows`。
- **`caption`**（可选）：表标题，≤200 字符。写清口径、来源与时间范围，例：`"各城市订单量（来源：订单库，2026-10-01 至 2026-10-07）"`。
- **`columns`**（必填）：列标题，1–8 列，每列 1–80 字符。
- **`rows`**（必填）：1–50 行，每行 1–8 个单元格，单元格 ≤500 字符；每行长度必须等于 `columns` 的长度（见 `CT-1`）。空数组是非法输入，不是「空状态」：没有数据就用文字说明。
- **`align`**（可选）：每列对齐，取值 `"left" | "right"`，长度必须等于 `columns` 的长度（见 `CT-2`）；省略按全部左对齐。金额、数量、比率右对齐。
- props 的 JSON Schema：

```json
{
  "type": "object",
  "properties": {
    "caption": { "type": "string", "maxLength": 200 },
    "columns": {
      "minItems": 1,
      "maxItems": 8,
      "type": "array",
      "items": { "type": "string", "minLength": 1, "maxLength": 80 }
    },
    "rows": {
      "minItems": 1,
      "maxItems": 50,
      "type": "array",
      "items": {
        "minItems": 1,
        "maxItems": 8,
        "type": "array",
        "items": { "type": "string", "maxLength": 500 }
      }
    },
    "align": {
      "minItems": 1,
      "maxItems": 8,
      "type": "array",
      "items": { "type": "string", "enum": ["left", "right"] }
    }
  },
  "required": ["columns", "rows"],
  "additionalProperties": false
}
```

## 还不存在的类型

切片 1 只有上面三个类型。`Chart`、`Kpi`、`Grid`、`Heading`、`Link`、`Image`、`Progress`、`Timeline`、`Diff` 等都不存在：写出来只会渲染成「不支持的组件类型」占位，不要尝试。类型只增不改，将来新增的类型会补进本文档。
