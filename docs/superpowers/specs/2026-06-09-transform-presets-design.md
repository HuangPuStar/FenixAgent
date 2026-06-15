# Transform 预设模板设计

> 状态：设计中 | 日期：2026-06-09

## 1. 动机

当前 transform 节点的 `output` 需要用户手写 JS 表达式。通过预设模板，用户从面板拖出即带预填表达式骨架，连线后 `inputs` 自动补全，改 key 名时表达式自动同步——最大限度减少手写。

## 2. 五种预设

| 预设 | 面板标签(en/zh) | 图标 | 初始 output |
|------|-----------------|------|------------|
| Extract | Extract / 提取 | `ListFilter` | 2 个字段提取行 |
| Filter | Filter / 过滤 | `Filter` | 1 行条件过滤 |
| Aggregate | Aggregate / 聚合 | `BarChart3` | total / avg / sum 三行 |
| Merge | Merge / 合并 | `Combine` | 1 行 Object.assign |
| Sort | Sort / 排序 | `ArrowUpDown` | 1 行 sort 降序 |

**所有预设底层都是 `type: "transform"`**，只是 `output` 初始内容不同。

## 3. 预设定义

```typescript
interface TransformPreset {
  id: string;                    // "extract" | "filter" | "aggregate" | "merge" | "sort"
  labelKey: string;              // i18n key
  icon: LucideIcon;
  color: string;                 // 统一用 transform 的 #f97316
  /** 默认 output 骨架 */
  defaultOutput: Record<string, string>;
  /** 需要 upstream 连接的最小数量 */
  minUpstream: number;
}
```

预设数据：

```typescript
const TRANSFORM_PRESETS: TransformPreset[] = [
  {
    id: "extract",
    labelKey: "nodes.preset_extract",
    icon: ListFilter,
    color: "#f97316",
    defaultOutput: {
      field1: "data.items.map(i => i.field1)",
      field2: "data.items.map(i => i.field2)",
    },
    minUpstream: 1,
  },
  {
    id: "filter",
    labelKey: "nodes.preset_filter",
    icon: Filter,
    color: "#f97316",
    defaultOutput: {
      filtered: "data.items.filter(i => i.field1 >= value1)",
    },
    minUpstream: 1,
  },
  {
    id: "aggregate",
    labelKey: "nodes.preset_aggregate",
    icon: BarChart3,
    color: "#f97316",
    defaultOutput: {
      total: "data.items.length",
      avg: "data.items.reduce((s, i) => s + i.field1, 0) / data.items.length",
      sum: "data.items.reduce((s, i) => s + i.field1, 0)",
    },
    minUpstream: 1,
  },
  {
    id: "merge",
    labelKey: "nodes.preset_merge",
    icon: Combine,
    color: "#f97316",
    defaultOutput: {
      combined: "Object.assign({}, src1, src2)",
    },
    minUpstream: 2,
  },
  {
    id: "sort",
    labelKey: "nodes.preset_sort",
    icon: ArrowUpDown,
    color: "#f97316",
    defaultOutput: {
      sorted: "data.items.sort((a, b) => b.field1 - a.field1)",
    },
    minUpstream: 1,
  },
];
```

## 4. 交互流程

### 4.1 拖出预设节点

1. 用户从面板拖 "提取" 到画布
2. 创建节点，`type: "transform"`，`output` = 预填的 `defaultOutput`
3. 节点显示为 transform 样式（橙色 Shuffle 图标），预览文字显示 `output` 的 key 列表

### 4.2 连线自动补 inputs

1. 用户把上游节点（如 `api_1`）连到 transform
2. 系统检测到新增连线，触发自动补全：
   - 插入 `depends_on: [api_1]`
   - 自动生成 `inputs`：按上游出现顺序分配变量名 `data`、`src1`、`src2`

**分配规则**（按预设类型）：

| 预设 | inputs 键名 | 来源 |
|------|-----------|------|
| Extract / Filter / Aggregate / Sort | `data` | 第 1 个上游 |
| Merge | `src1`, `src2` | 第 1~2 个上游 |

**表达式适配**：如果 inputs 键名和 `defaultOutput` 表达式中的变量名不一致，自动替换。例如 merge 的表达式从 `Object.assign({}, src1, src2)` 变为 `Object.assign({}, upstream_1, upstream_2)`（取决于上游节点 ID）。

### 4.3 Output key 改名自动同步表达式

用户在 NodeConfigCard 中修改 output 的 key 名时：

1. **简单映射**：key 从 `field1` 改 `name`，表达式 `data.items.map(i => i.field1)` 自动变为 `data.items.map(i => i.name)`
2. **非映射 key**：key `total` 改 `count` 不影响表达式（`data.items.length` 不依赖 key 名）
3. **规则**：仅当旧 key 名作为独立标识符出现在表达式中时（`.` 之后、参数名、变量名），才替换。正则：`/\b旧key\b/g`（但排除字符串字面量内的出现）

实现策略：检测到 key 改名时，对所有 `output` 表达式中出现旧 key 名的位置做替换。除非表达式不包含旧 key 名（如纯计算 `data.total`），则表达式不变。

## 5. 面板布局

当前面板有 shell/python/agent/api/audit 五个基础节点。transform 预设放在同一面板中，但用 visual separator 区分：

```
基础节点
[Shell] [Python] [Agent] [API] [Audit]

数据变换  
[提取] [过滤] [聚合] [合并] [排序]
```

预设节点拖出时用 transform 的颜色和图标，但标签用各自的预设名。

## 6. 改动清单

| 文件 | 改动 |
|------|------|
| `web/src/pages/workflow/WorkflowEditor.tsx` | `PALETTE_ITEMS` 替换原有的单一 transform 为 5 个预设；可能加分组逻辑 |
| `web/src/pages/workflow/nodes.tsx` | 预设的 `getPreview()` 逻辑复用 transform，显示 preset id |
| `web/src/pages/workflow/hooks/useWorkflowCanvas.ts` | `addNode()` 加 preset 参数，预设创建时注入 `defaultOutput` 和 `preset` 标记 |
| `web/src/pages/workflow/components/NodeConfigCard.tsx` | key 改名时自动同步表达式的逻辑 |
| `web/src/pages/workflow/components/NodeConfigPanel.tsx` | 同上 |
| `web/src/pages/workflow/yaml-utils.ts` | `flowToYaml()` 处理 `preset` 字段（忽略不写入 YAML，仅前端用） |
| `web/src/i18n/locales/en/workflows.json` | 新增 `nodes.preset_*` 翻译 |
| `web/src/i18n/locales/zh/workflows.json` | 同上 |
| `web/src/pages/workflow/edges.tsx` | `onConnect` 回调 → 检测新连到 transform 节点时触发 inputs 自动补全 |

**不涉及后端**：preset 是纯前端概念，YAML 中仍为 `type: transform`。

## 7. 关键设计决策

| 决定 | 说明 |
|------|------|
| preset 不写入 YAML | `preset` 字段仅前端运行时使用，保存时丢弃。YAML 只有标准 transform 字段 |
| inputs 键名固定 | Extract/Filter/Aggregate/Sort 用 `data`，Merge 用 `src1/src2`。后续可扩展为可自定义 |
| 连线时自动补 | 连接后立即补 `inputs` + `depends_on`，不要求用户手动配置 |
| key 改名同步 | 仅同步表达式中出现旧 key 名称的地方，纯计算式（如 `data.total`）不改动 |
| 预设节点也可手动改回普通 transform | 删除所有 output 行后，等同于空白 transform |
