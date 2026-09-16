/**
 * Transform 节点预设模板配置
 *
 * 五种预设底层都是 type: "transform"，区别在 output 默认值和 inputs 分配规则。
 * _preset 字段仅前端运行时使用，不写入 YAML。
 */

import type { LucideIcon } from "lucide-react";
import { ArrowUpDown, BarChart3, Combine, Filter, ListFilter } from "lucide-react";

/** 预设模板定义 */
export interface TransformPreset {
  /** 预设唯一标识 */
  id: string;
  /** i18n 翻译 key */
  labelKey: string;
  /** 面板展示图标 */
  icon: LucideIcon;
  /** 节点颜色（统一使用 transform 橙色） */
  color: string;
  /** 拖出节点时的默认 output */
  defaultOutput: Record<string, string>;
  /** 需要上游连接的最小数量（用于自动补 inputs 时分配变量名） */
  minUpstream: number;
}

export const TRANSFORM_PRESETS: TransformPreset[] = [
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

/** 通过 preset id 查找预设配置 */
export function getPresetById(id: string): TransformPreset | undefined {
  return TRANSFORM_PRESETS.find((p) => p.id === id);
}
