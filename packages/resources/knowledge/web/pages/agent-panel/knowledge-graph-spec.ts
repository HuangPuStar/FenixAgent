// web/pages/agent-panel/knowledge-graph-spec.ts
// G6 力导向图的**纯构建**层（§3.5 三层拆分的第一层）：度数分层、节点尺寸、tooltip 内容与
// 布局/样式配置都由输入决定，不碰 DOM、不持有实例，便于单独推理与替换 G6 版本。
//
// 从 `KnowledgeGraphPanel.tsx` 拆出（§4.7）：面板只管取数、生成进度与状态分支，
// 实例生命周期在 `use-knowledge-graph-canvas.ts`。

import type { ElementDatum, GraphOptions, IElementEvent } from "@antv/g6";
import type { KnowledgeGraphData } from "../../types/knowledge";

/** tooltip 中不同元素类型的颜色 */
const TooltipColorMap: Record<string, string> = {
  node: "text-slate-900",
  edge: "text-indigo-500",
};

/** tooltip 文案取词函数（字典键与图谱面板同一命名空间） */
type Translate = (key: string) => string;

interface KnowledgeGraphSpecOptions {
  container: HTMLDivElement;
  graph: KnowledgeGraphData["graph"];
  /** tooltip 的锚点 id（同一 doc 内多实例不冲突） */
  tooltipId: string;
  t: Translate;
}

/**
 * 构建 G6 图配置：先按度数分层（前 30% 作为带标签的 hub 节点），再据此派生节点尺寸、
 * 标签字号与布局参数。返回的对象可直接交给 `new Graph({...})`。
 */
export function buildKnowledgeGraphSpec({ container, graph, tooltipId, t }: KnowledgeGraphSpecOptions): GraphOptions {
  const { nodes, edges } = graph;

  // ── 预计算每个节点的度数（连接数），用于按重要性分层渲染 ──
  const degreeMap = new Map<string, number>();
  for (const n of nodes) degreeMap.set(n.id, 0);
  for (const e of edges) {
    degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
  }

  // 度数降序排列，取前 30% 作为"需要显示标签的 hub 节点"
  const sortedDegs = [...degreeMap.values()].sort((a, b) => b - a);
  const labelDegThreshold = Math.max(3, sortedDegs[Math.floor(sortedDegs.length * 0.3)] ?? 3);

  // 节点尺寸：基于度数，hub 节点大（带标签），边缘节点小（仅圆点）
  const nodeSize = (d: Record<string, unknown>) => {
    const deg = degreeMap.get((d.id as string) ?? "") ?? 0;
    return 40 + Math.min(deg * 22, 180); // 范围 40 ~ 220
  };
  const getMaxSize = (node: Record<string, unknown>) => nodeSize(node);

  return {
    container,
    autoFit: "view",
    autoResize: true,
    behaviors: [
      "drag-element",
      "drag-canvas",
      "zoom-canvas",
      {
        type: "hover-activate",
        degree: 1, // 悬停高亮一度关联节点
      },
    ],
    plugins: [
      {
        type: "tooltip",
        enterable: true,
        getContent: (e: IElementEvent, items: ElementDatum) => {
          if (!Array.isArray(items)) return;

          return items
            .flatMap((item) => {
              const colorCls = TooltipColorMap[e.targetType as string] ?? "text-slate-900";
              const title = (item?.name as string) || (item?.id as string) || "";
              const et = (item?.entity_type as string) || "";
              const w = item?.weight as number | undefined;
              const desc = (item?.description as string) || "";

              return [
                "<div ",
                `id="${tooltipId}"`,
                `aria-label="${item?.id}"`,
                'role="tooltip"',
                `class="${colorCls}"`,
                'style="max-width:320px"',
                ">",
                `<h3 style="font-weight:600;font-size:13px;margin-bottom:4px">${title}</h3>`,
                '<dl style="margin-bottom:4px;font-size:12px">',
                ...(et
                  ? [
                      '<div style="display:flex;align-items:center;gap:0.5ch">',
                      `<dt><b>${t("graph.entityType")}: </b></dt>`,
                      `<dd>${et}</dd>`,
                      "</div>",
                    ]
                  : []),
                ...(w != null
                  ? [
                      '<div style="display:flex;align-items:center;gap:0.5ch">',
                      `<dt><b>${t("graph.weight")}: </b></dt>`,
                      `<dd>${w}</dd>`,
                      "</div>",
                    ]
                  : []),
                "</dl>",
                ...(desc ? [`<p style="font-size:11px;color:#64748b;line-height:1.5">${desc}</p>`] : []),
                "</div>",
              ];
            })
            .join("");
        },
      },
    ],
    layout: {
      type: "force",
      preventOverlap: true,
      nodeSize: getMaxSize as unknown as number,
      // 节点数多时降低引力、增加排斥力，让图更分散
      gravity: nodes.length > 100 ? 0.3 : 0.8,
      factor: nodes.length > 100 ? 8 : 4,
      linkDistance: (_edge: unknown, source: unknown, target: unknown) => {
        const sourceSize = getMaxSize(source as Record<string, unknown>);
        const targetSize = getMaxSize(target as Record<string, unknown>);
        return sourceSize / 2 + targetSize / 2 + 150;
      },
    },
    node: {
      style: {
        size: (d: Record<string, unknown>) => nodeSize(d),
        // 仅 hub 节点（度数 >= 阈值）显示标签，避免大图标签糊成一团
        labelText: (d: Record<string, unknown>) => {
          const deg = degreeMap.get((d.id as string) ?? "") ?? 0;
          if (deg < labelDegThreshold) return "";
          return (d.name as string) || (d.id as string) || "";
        },
        // 标签字号与节点尺寸成比例，保证缩放后仍可读
        labelFontSize: (d: Record<string, unknown>) => Math.max(10, nodeSize(d) * 0.14),
        labelFill: "#1e293b",
        labelPlacement: "bottom",
        labelOffsetY: 4,
        labelWordWrap: true,
        labelMaxWidth: "250%",
        // 标签底色：白底圆角，防止与边线/节点重叠时不可读
        labelBackground: true,
        labelBackgroundFill: "#ffffff",
        labelBackgroundFillOpacity: 0.92,
        labelBackgroundRadius: 4,
        labelBackgroundLineWidth: 1,
        labelBackgroundStroke: "#e2e8f0",
        // 高亮态样式
        labelActiveFill: "#6366f1",
        labelActiveBackgroundFill: "#eef2ff",
      },
      palette: {
        type: "group",
        field: (d: Record<string, unknown>) => (d?.entity_type as string) || "default",
      },
    },
    edge: {
      style: (model: Record<string, unknown>) => {
        const weight: number = Number(model?.weight) || 2;
        return {
          stroke: "rgba(100,116,139,0.3)",
          lineDash: [8, 8],
          lineWidth: Math.min(weight * 3, 6),
        };
      },
    },
  };
}
