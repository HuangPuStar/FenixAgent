// web/pages/agent-panel/use-knowledge-graph-canvas.ts
// G6 画布的**实例生命周期**编排（§3.5 三层拆分的第二层）：惰性加载 G6、创建/销毁实例、
// 收敛布局后的 fitView、以及卸载与数据替换时的清理。配置构建在 `knowledge-graph-spec.ts`。
//
// 从 `KnowledgeGraphPanel.tsx` 拆出（§4.7）：面板不再持有 graphRef / 渲染令牌 / 兜底定时器，
// 只把 `containerRef` 挂到画布容器上。

import type { Graph } from "@antv/g6";
import { useCallback, useEffect, useId, useRef } from "react";
import type { KnowledgeGraphData } from "../../types/knowledge";
import { buildKnowledgeGraphSpec } from "./knowledge-graph-spec";

/** tooltip 文案取词函数（字典键与图谱面板同一命名空间） */
type Translate = (key: string) => string;

/**
 * 把 `graphData` 渲染成 G6 力导向图并管理其生命周期；换数据 / 卸载时销毁旧实例。
 * `graphData` 为 null（空态或加载中）时不渲染，已有实例按 effect cleanup 规则销毁。
 */
export function useKnowledgeGraphCanvas(graphData: KnowledgeGraphData | null, t: Translate) {
  const tooltipId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  /** 惰性加载 G6 期间的取消令牌：每次渲染递增，异步返回后发现令牌已变即丢弃本次结果。 */
  const renderTokenRef = useRef(0);
  /** 存储 fitOnce 兜底定时器的清理函数 */
  const graphOnceCleanupRef = useRef<(() => void) | null>(null);

  // 构建并渲染 G6 力导向图
  const renderGraph = useCallback(async () => {
    const container = containerRef.current;
    if (!container || !graphData) return;

    // G6 必须**惰性加载**：`@antv/g6` → `@antv/g` → `html2canvas` 在导入期就求值
    // `window.document.createElement`，静态导入会让本包 web 入口在无 DOM 的运行时（bun 测试、
    // 以及任何间接引入本包 web 入口的用例）加载即崩。类型侧仍用 `import type`（零运行时成本）。
    const token = ++renderTokenRef.current;
    const { Graph } = await import("@antv/g6");
    // 加载期间组件已卸载或数据已被替换：丢弃本次渲染，避免留下无人销毁的图实例。
    if (token !== renderTokenRef.current || containerRef.current !== container) return;

    const graph = new Graph(buildKnowledgeGraphSpec({ container, graph: graphData.graph, tooltipId, t }));

    // 销毁旧图再创建新图
    if (graphRef.current) {
      graphRef.current.destroy();
    }
    graphRef.current = graph;

    // G6 v5 的 setData 需要 NodeData/EdgeData，这里做类型转换
    graph.setData({ nodes: graphData.graph.nodes as never, edges: graphData.graph.edges as never });
    graph.render();

    // 力导向布局是异步迭代的，autoFit 在渲染瞬间执行时坐标还在原点附近，
    // 导致初始视图要么太放大（一坨）要么偏离中心。等布局收敛后再 fitView，
    // 并留 padding，保证初始视图合理且不撑爆画布。
    const fitOnce = () => {
      try {
        graph.fitView({ when: "always" }, false);
      } catch {
        // 忽略：节点尚未就位时 fitView 可能抛错
      }
    };
    graph.once("afterlayout", fitOnce);
    // 兜底：如果 afterlayout 未触发（极小图），延迟再 fit 一次
    const fallbackTimer = setTimeout(fitOnce, 2500);
    graphOnceCleanupRef.current = () => clearTimeout(fallbackTimer);
  }, [graphData, t, tooltipId]);

  useEffect(() => {
    if (graphData) {
      void renderGraph();
    }
    return () => {
      // 令在飞的 G6 惰性加载失效：卸载/数据替换后不再创建无人销毁的图实例。
      renderTokenRef.current += 1;
      if (graphOnceCleanupRef.current) {
        graphOnceCleanupRef.current();
        graphOnceCleanupRef.current = null;
      }
      if (graphRef.current) {
        graphRef.current.destroy();
        graphRef.current = null;
      }
    };
  }, [graphData, renderGraph]);

  return { containerRef };
}
