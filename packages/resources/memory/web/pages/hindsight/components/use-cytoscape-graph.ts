/**
 * `Graph2d` 的编排层：容器挂载、cytoscape 实例的创建 / 重建 / 销毁，以及悬停与聚焦状态。
 *
 * 拆开的理由：「容器 → 实例 → 布局 → 事件」是一条有顺序约束的链路，与 JSX 同处一个文件时，
 * 组件顶部被 refs 与三个 effect 占满（原文件 713 行，渲染部分落在 590 行之后），
 * 改配色或改交互都要先翻过整套初始化流程。分工：纯整形在 `graph2d-model.ts`、
 * 外观在 `graph2d-styles.ts`、本文件只做编排（§3.5 的「编排 hook」层）。
 *
 * `cyRef` / `isInitializingRef` / `lastDataSignatureRef` 一律留在 hook 内：它们是「这个实例建过没有」
 * 的判据，交给调用方持有就等于造出第二个所有者。调用方只拿到容器 `ref` 与渲染所需的状态。
 * 图形逻辑与 `Constellation`（自绘 canvas）刻意分叉、不共享（已裁定，见前端规范 §4.8）。
 */

import { useTheme } from "@fenix/ui-components/lib/theme";
import cytoscape from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphData, GraphLink, GraphNode } from "./graph-model";
import {
  buildCytoscapeElements,
  countCytoscapeElements,
  type GraphElementOptions,
  graphDataSignature,
  limitGraphData,
} from "./graph2d-model";
import { buildGraph2dStylesheet, FOCSE_LAYOUT_OPTIONS } from "./graph2d-styles";

export interface UseCytoscapeGraphOptions extends GraphElementOptions {
  data: GraphData;
  showLabels?: boolean;
  maxNodes?: number;
  onNodeClick?: (node: GraphNode) => void;
  onNodeHover?: (node: GraphNode | null) => void;
}

/** 渲染壳需要的状态：容器 `ref`、三态，以及链接 tooltip 的定位。 */
export interface CytoscapeGraphView {
  /** 传给画布容器的 `ref`；挂载完成后 hook 才会初始化 cytoscape。 */
  containerRef: (element: HTMLDivElement | null) => void;
  /** 首次挂载是否完成——容器只在挂载后渲染，避免首帧量到 0 尺寸。 */
  isMounted: boolean;
  isLoading: boolean;
  isDarkMode: boolean;
  /** 限量后的节点数（渲染壳的空态判据）。 */
  nodeCount: number;
  hoveredLink: GraphLink | null;
  linkTooltipPos: { x: number; y: number } | null;
}

export function useCytoscapeGraph({
  data,
  showLabels = true,
  maxNodes,
  onNodeClick,
  onNodeHover,
  nodeColorFn,
  nodeSizeFn,
  linkColorFn,
  linkWidthFn,
}: UseCytoscapeGraphOptions): CytoscapeGraphView {
  const [containerDiv, setContainerDiv] = useState<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const isInitializingRef = useRef(false);
  const lastDataSignatureRef = useRef<string>("");
  const [_hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [hoveredLink, setHoveredLink] = useState<GraphLink | null>(null);
  const [linkTooltipPos, setLinkTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isMounted, setIsMounted] = useState(false);
  const [isFocusMode, setIsFocusMode] = useState(false);
  // 暗色判定改读主题上下文（原为本地 MutationObserver 观察 `documentElement` 的 class——
  // 那是主题实现的内部细节，且全仓另有一份逐字副本在 Constellation.tsx）。
  const { resolvedTheme } = useTheme();
  const isDarkMode = resolvedTheme === "dark";

  // Use refs to store callbacks and data to prevent re-renders from resetting the graph
  const onNodeClickRef = useRef(onNodeClick);
  const onNodeHoverRef = useRef(onNodeHover);
  const fullDataRef = useRef(data);
  const nodeColorFnRef = useRef(nodeColorFn);
  const linkColorFnRef = useRef(linkColorFn);
  const isFocusModeRef = useRef(isFocusMode);
  onNodeClickRef.current = onNodeClick;
  onNodeHoverRef.current = onNodeHover;
  fullDataRef.current = data;
  nodeColorFnRef.current = nodeColorFn;
  linkColorFnRef.current = linkColorFn;
  isFocusModeRef.current = isFocusMode;

  // Transform and limit data - only limit nodes, show ALL links between visible nodes
  const graphData = useMemo(() => limitGraphData(data, maxNodes), [data, maxNodes]);

  // Track mounting state
  useEffect(() => {
    setIsMounted(true);
    return () => setIsMounted(false);
  }, []);

  // Convert to Cytoscape format
  const cyElements = useMemo(
    () => buildCytoscapeElements(graphData, { nodeColorFn, nodeSizeFn, linkColorFn, linkWidthFn }),
    [graphData, nodeColorFn, nodeSizeFn, linkColorFn, linkWidthFn],
  );

  // Create data signature to prevent double initialization
  const dataSignature = useMemo(
    () => graphDataSignature(graphData.nodes, graphData.links, { showLabels, isDarkMode, maxNodes }),
    [graphData.nodes, graphData.links, showLabels, isDarkMode, maxNodes],
  );

  // 容器尺寸变化时只通知 Cytoscape 重算 viewport，不重置用户缩放与平移。
  useEffect(() => {
    if (!containerDiv) return;
    const observer = new ResizeObserver(() => {
      const cy = cyRef.current;
      if (cy && !cy.destroyed()) cy.resize();
    });
    observer.observe(containerDiv);
    return () => observer.disconnect();
  }, [containerDiv]);

  // Initialize Cytoscape
  useEffect(() => {
    let isCancelled = false;

    // Small delay to ensure container is mounted
    const timeout = setTimeout(() => {
      if (isCancelled || !isMounted || !containerDiv || isInitializingRef.current) return;

      // Check if data has actually changed to prevent double initialization
      if (lastDataSignatureRef.current === dataSignature) {
        console.log("Data signature unchanged, skipping graph initialization");
        return;
      }

      // Additional validation - check if element has dimensions
      const rect = containerDiv.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        console.warn("Container has no dimensions, skipping cytoscape initialization");
        setIsLoading(false);
        return;
      }

      // Handle empty data case
      if (cyElements.length === 0) {
        setIsLoading(false);
        return;
      }

      // Check if we already have a graph with the same data
      if (cyRef.current && !cyRef.current.destroyed()) {
        const currentNodes = cyRef.current.nodes().length;
        const currentEdges = cyRef.current.edges().length;
        const { nodes: newNodes, edges: newEdges } = countCytoscapeElements(cyElements);

        // If the element counts are the same, just update styles and skip reinitialization
        if (currentNodes === newNodes && currentEdges === newEdges) {
          console.log("Graph already initialized with same data, skipping reinitialization");
          setIsLoading(false);
          return;
        }

        // Clean up existing graph before creating new one
        console.log("Data changed, destroying existing graph");
        cyRef.current.destroy();
        cyRef.current = null;
      }

      setIsLoading(true);
      isInitializingRef.current = true;

      try {
        console.log("Initializing cytoscape with container:", containerDiv);
        console.log("Elements count:", cyElements.length);
        console.log("Sample elements:", cyElements.slice(0, 2));

        // Try minimal initialization first
        // cytoscape style 类型定义不完整，样式表整体断言（见 graph2d-styles.ts）
        const cy = cytoscape({
          container: containerDiv,
          elements: [],
          // Disable edge selection to prevent gray border on click
          selectionType: "single",
          userZoomingEnabled: true,
          userPanningEnabled: true,
          boxSelectionEnabled: false,
          // Disable automatic layout on initialization
          layout: { name: "preset" },
          style: buildGraph2dStylesheet(showLabels, isDarkMode),
        });

        cyRef.current = cy;

        console.log("Cytoscape initialized successfully");

        // Add elements after initialization
        if (cyElements.length > 0) {
          console.log("Adding elements to cytoscape");
          cy.add(cyElements);
          // fcose 布局参数超出 cytoscape BaseLayoutOptions 类型定义，使用类型断言
          (cy.layout as unknown as (opts: Record<string, unknown>) => { run: () => void })(FOCSE_LAYOUT_OPTIONS).run();

          // Fit to viewport
          cy.fit();
        }

        // Add basic interactions
        cy.on("tap", "node", (evt: cytoscape.EventObject) => {
          const node = evt.target as cytoscape.NodeSingular;
          const originalNode = node.data("originalNode") as GraphNode;
          if (onNodeClickRef.current && originalNode) {
            onNodeClickRef.current(originalNode);
          }
        });

        cy.on("mouseover", "node", (evt: cytoscape.EventObject) => {
          const node = evt.target as cytoscape.NodeSingular;
          const originalNode = node.data("originalNode") as GraphNode;
          setHoveredNode(originalNode);
          if (onNodeHoverRef.current && originalNode) {
            onNodeHoverRef.current(originalNode);
          }
          if (containerDiv) containerDiv.style.cursor = "pointer";
        });

        cy.on("mouseout", "node", () => {
          setHoveredNode(null);
          if (onNodeHoverRef.current) {
            onNodeHoverRef.current(null);
          }
          if (containerDiv) containerDiv.style.cursor = "default";
        });

        // Edge hover handlers - only work in focus mode and on highlighted edges
        cy.on("mouseover", "edge", (evt: cytoscape.EventObject) => {
          const edge = evt.target;

          // Only allow interaction if we're in focus mode and edge is highlighted
          if (!isFocusModeRef.current || !edge.hasClass("connection")) {
            return;
          }

          const originalLink = edge.data("originalLink") as GraphLink;
          if (originalLink) {
            setHoveredLink(originalLink);
            // Get position for tooltip
            const renderedPos = edge.renderedMidpoint();
            setLinkTooltipPos({ x: renderedPos.x, y: renderedPos.y });
          }
        });

        cy.on("mouseout", "edge", (evt: cytoscape.EventObject) => {
          const edge = evt.target;

          // Only clear hover state if we were actually hovering a highlighted edge
          if (!isFocusModeRef.current || !edge.hasClass("connection")) {
            return;
          }

          setHoveredLink(null);
          setLinkTooltipPos(null);
        });

        // Prevent edge selection to avoid gray border on click
        cy.on("select", "edge", (evt: cytoscape.EventObject) => {
          evt.target.unselect();
        });

        // Double-click to focus on node and its connections
        cy.on("dblclick", "node", (evt: cytoscape.EventObject) => {
          const focusedNode = evt.target as cytoscape.NodeSingular;
          const focusedNodeId = focusedNode.id();

          console.log("Double-clicked node:", focusedNodeId);

          // Enter focus mode
          setIsFocusMode(true);

          // Clear any existing focus classes
          cy.elements().removeClass("dimmed focused connected connection");

          // Get all connected nodes and edges
          const connectedElements = focusedNode.neighborhood();
          const connectedNodes = connectedElements.nodes();
          const connectedEdges = connectedElements.edges();

          // Apply styling classes
          cy.elements().addClass("dimmed"); // Dim everything first
          focusedNode.removeClass("dimmed").addClass("focused"); // Highlight the focused node
          connectedNodes.removeClass("dimmed").addClass("connected"); // Highlight connected nodes
          connectedEdges.removeClass("dimmed").addClass("connection"); // Highlight connecting edges

          // Create a collection of all relevant elements for positioning
          const relevantElements = focusedNode.union(connectedElements);

          // Reorient the graph to focus on this subgraph
          cy.animate(
            {
              fit: {
                eles: relevantElements,
                padding: 100,
              },
              center: {
                eles: focusedNode,
              },
            },
            {
              duration: 800,
              easing: "ease-out-cubic",
            },
          );
        });

        // Click on background to reset focus
        cy.on("tap", (evt: cytoscape.EventObject) => {
          if (evt.target === cy) {
            console.log("Clicked background - resetting focus");

            // Exit focus mode
            setIsFocusMode(false);

            // Remove all focus classes
            cy.elements().removeClass("dimmed focused connected connection");

            // Zoom out to show all elements
            cy.animate(
              {
                fit: {
                  eles: cy.elements(),
                  padding: 50,
                },
              },
              {
                duration: 600,
                easing: "ease-out",
              },
            );
          }
        });

        setIsLoading(false);
        isInitializingRef.current = false;
        lastDataSignatureRef.current = dataSignature;
      } catch (error) {
        console.error("Error initializing cytoscape:", error);
        setIsLoading(false);
        isInitializingRef.current = false;
      }
    }, 100); // 100ms delay

    return () => {
      isCancelled = true;
      clearTimeout(timeout);
      isInitializingRef.current = false;
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
    };
  }, [
    dataSignature,
    isMounted,
    containerDiv,
    isDarkMode,
    cyElements.filter,
    cyElements.slice,
    showLabels,
    cyElements.length,
    cyElements,
  ]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (cyRef.current) {
        cyRef.current.resize();
        cyRef.current.fit(undefined, 80);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return {
    containerRef: setContainerDiv,
    isMounted,
    isLoading,
    isDarkMode,
    nodeCount: graphData.nodes.length,
    hoveredLink,
    linkTooltipPos,
  };
}
