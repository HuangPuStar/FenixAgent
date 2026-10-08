# ui-spec 完整示例与反例

<!--
  同步测试依赖以下格式契约（packages/ui-components/web/__tests__/ui-spec-catalog-doc-sync.test.ts），改格式前先看测试：
  · ```ui-spec 围栏 = 可直接粘贴的完整合法 Spec：测试会 parseUISpec 并对每个元素 resolveElement，必须全部成功；
  · ```ui-spec-invalid 围栏 = 反例，前端不认这个语言标记、不会渲染；紧邻其上的第一个非空行必须是 `预期：<reason>`，
    其中 reason ∈ json | structure | version | limits | unsupported | invalid-props，测试按该声明断言实际结果。
  字段、必填、枚举与限额见 references/catalog.md。
-->

## 示例 1：中文业务场景 · 明细表（Stack + Text + Table）

```ui-spec
{
  "version": 1,
  "root": "report",
  "elements": {
    "report": { "type": "Stack", "props": { "gap": "md" }, "children": ["headline", "orders"] },
    "headline": {
      "type": "Text",
      "props": { "text": "本周华东区共处理 2,702 单，其中 34 单退款（1.3%）。" }
    },
    "orders": {
      "type": "Table",
      "props": {
        "caption": "各城市订单量与退款率（来源：订单库，2026-10-01 至 2026-10-07）",
        "columns": ["城市", "订单量", "退款单数", "退款率"],
        "rows": [
          ["上海", "1,284", "15", "1.2%"],
          ["杭州", "906", "7", "0.8%"],
          ["南京", "512", "12", "2.3%"]
        ],
        "align": ["left", "right", "right", "right"]
      }
    }
  }
}
```

要点：同一批字段的多条明细用一张 `Table`，不要拆成卡片堆；数字列用 `align` 右对齐；来源与时间范围写在 `caption` 里。

## 示例 2：最小可用 · 两段文字（Stack + Text）

```ui-spec
{
  "version": 1,
  "root": "note",
  "elements": {
    "note": { "type": "Stack", "props": { "gap": "sm" }, "children": ["body", "footnote"] },
    "body": { "type": "Text", "props": { "text": "构建产物已发布到预发环境，健康检查通过。" } },
    "footnote": {
      "type": "Text",
      "props": { "text": "构建号 2026.10.08-3，耗时 4 分 12 秒。", "tone": "muted" }
    }
  }
}
```

要点：`Stack.children` 里写的是其它元素的 id；`Text` 与 `Table` 是叶子节点，不能带 `children`。

## 示例 3：对照与提醒（Stack + Table + Text）

```ui-spec
{
  "version": 1,
  "root": "plan",
  "elements": {
    "plan": { "type": "Stack", "props": { "gap": "lg" }, "children": ["changes", "warning"] },
    "changes": {
      "type": "Table",
      "props": {
        "caption": "本次迁移前后对照（依据 migration_20261007.sql）",
        "columns": ["项目", "迁移前", "迁移后"],
        "rows": [
          ["技能存储路径", "skills/id", "skills/组织名/技能名"],
          ["归档格式", "zip", "tar.gz"]
        ]
      }
    },
    "warning": {
      "type": "Text",
      "props": { "text": "回滚前必须先停写：迁移期间的并发写入会丢失最后一个批次。", "tone": "danger" }
    }
  }
}
```

要点：省略 `align` 时按全部左对齐；`tone: "danger"` 只用于真正需要提醒的结论。

## 反例（这些写法会被整块或逐元素拒绝）

### 反例 1：JSON 语法错误（尾逗号）

预期：json

```ui-spec-invalid
{
  "version": 1,
  "root": "root",
  "elements": { "root": { "type": "Text", "props": { "text": "示例" } }, }
}
```

### 反例 2：顶层多写字段

预期：structure

```ui-spec-invalid
{ "version": 1, "root": "root", "elements": { "root": { "type": "Text", "props": { "text": "示例" } } }, "title": "报告" }
```

### 反例 3：版本不支持

预期：version

```ui-spec-invalid
{ "version": 2, "root": "root", "elements": { "root": { "type": "Text", "props": { "text": "示例" } } } }
```

### 反例 4：元素 id 超过 80 字符

预期：limits

```ui-spec-invalid
{
  "version": 1,
  "root": "id_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "elements": {
    "id_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx": {
      "type": "Text",
      "props": { "text": "示例" }
    }
  }
}
```

### 反例 5：目录外的类型（该元素占位，兄弟继续渲染）

预期：unsupported

```ui-spec-invalid
{
  "version": 1,
  "root": "report",
  "elements": {
    "report": { "type": "Stack", "props": { "gap": "md" }, "children": ["headline", "trend"] },
    "headline": { "type": "Text", "props": { "text": "近 7 天订单量小幅回落。" } },
    "trend": { "type": "Chart", "props": { "series": [128, 131, 119, 96, 88, 91, 84] } }
  }
}
```

### 反例 6：表格行列不一致

预期：invalid-props

```ui-spec-invalid
{
  "version": 1,
  "root": "orders",
  "elements": {
    "orders": {
      "type": "Table",
      "props": {
        "columns": ["城市", "订单量"],
        "rows": [["上海", "1,284"], ["杭州"]]
      }
    }
  }
}
```
