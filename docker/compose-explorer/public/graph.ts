/**
 * SVG 渲染：节点 = 编排文件，边 = 结构关系；带平移缩放与悬停高亮。
 *
 * 只画编排级视图（简单优先）：服务级细节放在右侧面板里，图里用角标表示「同文件内还有几条 depends_on」。
 * 所有文本都走 textContent 写入，不拼 HTML，避免文件内容/名字影响渲染。
 */

import type { EdgeKind, GraphLink, GraphModel, GraphNode, Selection } from "./types.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

const KIND_COLOR: Record<EdgeKind, string> = {
  include: "#64748b",
  network: "#38bdf8",
  service: "#a78bfa",
  depends_on: "#f0a44b",
};

const ROLE_COLOR = {
  root: "#58a6ff",
  base: "#2dd4bf",
  dependency: "#8ea4bb",
} as const;

const KIND_TITLE: Record<EdgeKind, string> = {
  include: "include 引入",
  network: "共享网络",
  service: "服务引用",
  depends_on: "depends_on",
};

export type GraphHandlers = {
  onSelect: (selection: Selection) => void;
};

export type GraphView = {
  render: (model: GraphModel, selection: Selection) => void;
  resetView: () => void;
};

function element<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function positionTooltip(tooltip: HTMLElement, event: MouseEvent): void {
  const bounds = tooltip.getBoundingClientRect();
  const left = Math.min(event.clientX + 14, window.innerWidth - bounds.width - 12);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, event.clientY + 14)}px`;
}

export function createGraph(svg: SVGSVGElement, tooltip: HTMLElement, handlers: GraphHandlers): GraphView {
  const defs = element("defs");
  for (const [kind, color] of Object.entries(KIND_COLOR)) {
    // 每条边按类型取箭头：同色箭头保证读出「这条线在讲哪种关系」。
    const marker = element("marker", {
      id: `arrow-${kind}`,
      viewBox: "0 0 10 10",
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: "auto-start-reverse",
    });
    marker.append(element("path", { d: "M 0 1 L 10 5 L 0 9 z", fill: color }));
    defs.append(marker);
  }
  const unmetMarker = element("marker", {
    id: "arrow-unmet",
    viewBox: "0 0 10 10",
    refX: 9,
    refY: 5,
    markerWidth: 7,
    markerHeight: 7,
    orient: "auto-start-reverse",
  });
  unmetMarker.append(element("path", { d: "M 0 1 L 10 5 L 0 9 z", fill: "#ef4444" }));
  defs.append(unmetMarker);

  const viewport = element("g");
  svg.append(defs, viewport);

  let scale = 1;
  let translate = { x: 0, y: 0 };
  let model: GraphModel | null = null;
  let selection: Selection = null;
  const nodeElements = new Map<string, SVGGElement>();
  const linkElements = new Map<string, SVGGElement>();
  const linkShapes = new Map<string, { path: SVGPathElement; from: GraphNode; to: GraphNode; baseWidth: number }>();

  const showTooltip = (event: MouseEvent, lines: string[]): void => {
    tooltip.textContent = lines.filter(Boolean).join("\n");
    tooltip.hidden = false;
    positionTooltip(tooltip, event);
  };
  const moveTooltip = (event: MouseEvent): void => {
    if (!tooltip.hidden) positionTooltip(tooltip, event);
  };
  const hideTooltip = (): void => {
    tooltip.hidden = true;
  };

  const applyTransform = (): void => {
    viewport.setAttribute("transform", `translate(${translate.x} ${translate.y}) scale(${scale})`);
  };

  function resetView(): void {
    if (!model) return;
    const bounds = svg.getBoundingClientRect();
    const nextScale = Math.min(
      1,
      Math.min((bounds.width - 40) / Math.max(1, model.width), (bounds.height - 40) / Math.max(1, model.height)),
    );
    scale = Math.max(0.25, nextScale);
    translate = {
      x: (bounds.width - model.width * scale) / 2,
      y: (bounds.height - model.height * scale) / 2,
    };
    applyTransform();
  }

  function curveFor(from: GraphNode, to: GraphNode): { d: string; midX: number; midY: number } {
    const forward = to.x > from.x;
    const startX = forward ? from.x + from.width : from.x;
    const startY = from.y + from.height / 2;
    const endX = forward ? to.x : to.x + to.width;
    const endY = to.y + to.height / 2;
    const distance = Math.abs(endX - startX);
    const bow = Math.max(40, distance * 0.35);
    // 反向边（目标在左侧）把控制点外扩成回路，避免直线穿过节点。
    const direction = forward ? 1 : -1;
    const c1x = startX + bow * direction;
    const c2x = endX - bow * direction;
    return {
      d: `M ${startX} ${startY} C ${c1x} ${startY}, ${c2x} ${endY}, ${endX} ${endY}`,
      midX: (startX + endX) / 2,
      midY: (startY + endY) / 2,
    };
  }

  function buildLinkElement(link: GraphLink, nodesById: Map<string, GraphNode>): SVGGElement | null {
    const from = nodesById.get(link.from);
    const to = nodesById.get(link.to);
    if (!from || !to) return null;

    const group = element("g", { class: "link" });
    const color = link.satisfied ? KIND_COLOR[link.kind] : "#ef4444";
    const curve = curveFor(from, to);
    const path = element("path", {
      d: curve.d,
      fill: "none",
      stroke: color,
      "stroke-width": link.count > 1 ? 2.2 : 1.4,
      "stroke-dasharray": link.satisfied ? "" : "6 4",
      "marker-end": `url(#arrow-${link.satisfied ? link.kind : "unmet"})`,
      "stroke-linejoin": "round",
    });
    group.append(path);
    const baseWidth = link.count > 1 ? 2.2 : 1.4;
    linkShapes.set(link.id, { path, from, to, baseWidth });

    const label = element("text", {
      x: curve.midX,
      y: curve.midY - 5,
      "text-anchor": "middle",
      "font-size": 10,
      "font-family": "var(--mono)",
      fill: color,
      "paint-order": "stroke",
      stroke: "#0b1017",
      "stroke-width": 3,
    });
    label.textContent = link.count > 1 ? `${link.label} ×${link.count}` : link.label;
    group.append(label);

    group.addEventListener("pointerenter", (event) => {
      path.setAttribute("stroke-width", "3");
      showTooltip(event as MouseEvent, [
        `${KIND_TITLE[link.kind]}：${link.label}${link.count > 1 ? `（${link.count} 处引用）` : ""}`,
        `${from.label} → ${to.label}`,
        link.satisfied ? "" : `依赖未满足：${link.blockedBy ?? "目标未启用"}`,
        link.evidence.length > 0 ? `证据 ${link.evidence.length} 条，点击在右侧查看` : "点击查看详情",
      ]);
    });
    group.addEventListener("pointermove", (event) => moveTooltip(event as MouseEvent));
    group.addEventListener("pointerleave", () => {
      linkShapes.get(link.id)?.path.setAttribute("stroke-width", String(baseWidth));
      hideTooltip();
    });
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onSelect({ kind: "edge", edgeId: link.id });
    });

    linkElements.set(link.id, group);
    return group;
  }

  function buildNodeElement(node: GraphNode): SVGGElement {
    const color = ROLE_COLOR[node.role];
    const group = element("g", { class: "node" });
    const dimmed = node.role === "dependency" && node.state !== "enabled";
    const rect = element("rect", {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      rx: 9,
      fill: "#131c27",
      stroke: color,
      "stroke-width": 1.4,
      "stroke-dasharray": dimmed ? "5 4" : "",
      opacity: dimmed ? 0.85 : 1,
    });
    group.append(rect);

    const title = element("text", {
      x: node.x + 12,
      y: node.y + 24,
      "font-size": 13,
      "font-weight": 600,
      fill: "#e6eef7",
    });
    title.textContent = node.variant ? `${node.label} · 变体` : node.label;
    group.append(title);

    const sub = element("text", {
      x: node.x + 12,
      y: node.y + 41,
      "font-size": 10,
      "font-family": "var(--mono)",
      fill: "#8ea4bb",
    });
    sub.textContent = node.sublabel;
    group.append(sub);

    const stateText =
      node.role === "dependency"
        ? node.state === "enabled"
          ? "● 已启用"
          : node.state === "disabled"
            ? "○ 未启用"
            : "○ 开关未声明"
        : "● 常驻";
    const state = element("text", {
      x: node.x + 12,
      y: node.y + 56,
      "font-size": 10,
      "font-family": "var(--mono)",
      fill: node.state === "enabled" ? "#34d399" : "#7b8ea3",
    });
    state.textContent = stateText;
    group.append(state);

    const badges: string[] = [`${node.serviceCount} 服务`];
    if (node.internalDeps > 0) badges.push(`${node.internalDeps} 内部依赖`);
    const badge = element("text", {
      x: node.x + node.width - 12,
      y: node.y + 56,
      "text-anchor": "end",
      "font-size": 10,
      "font-family": "var(--mono)",
      fill: "#64788d",
    });
    badge.textContent = badges.join(" · ");
    group.append(badge);

    group.addEventListener("pointerenter", (event) => {
      highlightNeighbourhood(node.id);
      showTooltip(event as MouseEvent, [
        node.sublabel,
        `${node.serviceCount} 个服务${node.internalDeps > 0 ? ` · ${node.internalDeps} 条内部依赖` : ""}`,
        node.state === "disabled" ? "该栈在 docker/deploy.env 里是关闭的" : "",
      ]);
    });
    group.addEventListener("pointermove", (event) => moveTooltip(event as MouseEvent));
    group.addEventListener("pointerleave", () => {
      clearHighlight();
      hideTooltip();
    });
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      handlers.onSelect({ kind: "doc", docId: node.id });
    });

    nodeElements.set(node.id, group);
    return group;
  }

  function highlightNeighbourhood(nodeId: string): void {
    const connectedNodes = new Set<string>([nodeId]);
    const connectedLinks = new Set<string>();
    for (const [id, shape] of linkShapes) {
      if (shape.from.id === nodeId || shape.to.id === nodeId) {
        connectedLinks.add(id);
        connectedNodes.add(shape.from.id);
        connectedNodes.add(shape.to.id);
      }
    }
    for (const [id, group] of nodeElements) group.style.opacity = connectedNodes.has(id) ? "1" : "0.16";
    for (const [id, group] of linkElements) group.style.opacity = connectedLinks.has(id) ? "1" : "0.12";
  }

  function clearHighlight(): void {
    for (const group of nodeElements.values()) group.style.opacity = "";
    for (const group of linkElements.values()) group.style.opacity = "";
  }

  function applySelection(): void {
    const selectedDoc = selection?.kind === "doc" ? selection.docId : null;
    const selectedEdge = selection?.kind === "edge" ? selection.edgeId : null;
    for (const [id, group] of nodeElements) {
      const rect = group.querySelector("rect");
      if (!rect) continue;
      rect.setAttribute("stroke-width", id === selectedDoc ? "2.6" : "1.4");
      group.classList.toggle("is-selected", id === selectedDoc);
    }
    for (const [id, shape] of linkShapes) {
      shape.path.setAttribute(
        "stroke-width",
        id === selectedEdge ? String(shape.baseWidth + 1.6) : String(shape.baseWidth),
      );
      linkElements.get(id)?.classList.toggle("is-selected", id === selectedEdge);
    }
  }

  function render(nextModel: GraphModel, nextSelection: Selection): void {
    model = nextModel;
    selection = nextSelection;
    nodeElements.clear();
    linkElements.clear();
    linkShapes.clear();
    viewport.replaceChildren();

    const nodesById = new Map(nextModel.nodes.map((node) => [node.id, node]));
    const linkLayer = element("g");
    const nodeLayer = element("g");
    for (const link of nextModel.links) {
      const group = buildLinkElement(link, nodesById);
      if (group) linkLayer.append(group);
    }
    for (const node of nextModel.nodes) nodeLayer.append(buildNodeElement(node));
    viewport.append(linkLayer, nodeLayer);

    for (const node of nextModel.nodes) nodeElements.get(node.id)?.classList.toggle("is-dim", !node.matched);
    for (const link of nextModel.links) linkElements.get(link.id)?.classList.toggle("is-dim", !link.matched);

    if (scale === 1 && translate.x === 0 && translate.y === 0) resetView();
    else applyTransform();
    applySelection();
  }

  // ── 平移与缩放 ─────────────────────────────────────
  let panning = false;
  let lastPoint = { x: 0, y: 0 };
  let pointerDownAt = { x: 0, y: 0 };

  svg.addEventListener("pointerdown", (event) => {
    if ((event.target as Element).closest(".node, .link")) return;
    panning = true;
    lastPoint = { x: event.clientX, y: event.clientY };
    pointerDownAt = { x: event.clientX, y: event.clientY };
    svg.setPointerCapture(event.pointerId);
    svg.classList.add("is-panning");
  });
  svg.addEventListener("pointermove", (event) => {
    if (!panning) return;
    translate = { x: translate.x + (event.clientX - lastPoint.x), y: translate.y + (event.clientY - lastPoint.y) };
    lastPoint = { x: event.clientX, y: event.clientY };
    applyTransform();
  });
  const endPan = (event: PointerEvent): void => {
    if (!panning) return;
    panning = false;
    svg.releasePointerCapture(event.pointerId);
    svg.classList.remove("is-panning");
  };
  svg.addEventListener("pointerup", endPan);
  svg.addEventListener("pointercancel", endPan);
  // 平移结束的那次 click 不该清空选择：只有几乎没移动过才算「点了空白处」。
  svg.addEventListener("click", (event) => {
    if (Math.abs(event.clientX - pointerDownAt.x) + Math.abs(event.clientY - pointerDownAt.y) > 4) return;
    handlers.onSelect(null);
  });
  svg.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const bounds = svg.getBoundingClientRect();
      const pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const factor = Math.exp(-event.deltaY * 0.0015);
      const nextScale = Math.min(2.4, Math.max(0.2, scale * factor));
      translate = {
        x: pointer.x - ((pointer.x - translate.x) * nextScale) / scale,
        y: pointer.y - ((pointer.y - translate.y) * nextScale) / scale,
      };
      scale = nextScale;
      applyTransform();
    },
    { passive: false },
  );

  return { render, resetView };
}
