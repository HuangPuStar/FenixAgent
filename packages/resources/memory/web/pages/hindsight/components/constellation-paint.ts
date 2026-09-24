/**
 * `Constellation` 的逐帧绘制主体：背景 → 连线 → 节点（带标签去重栅格）→ 图例。
 *
 * 这是从动画循环里搬出来的纯绘制过程：入参是 canvas 上下文、`canvas` 自身（要按 backing store 清屏）、
 * 可变交互状态与场景。搬出来之后，动画循环只剩「取 canvas / 取 ctx / 画一帧 / 排下一帧」，
 * 与模块定位（`ctx.restore()` 之后才排帧）的关系一眼可见。
 *
 * 绘制顺序与数值口径逐字照抄迁移前：位置先用目标值（无插值动画），命中测试在画之前完成，
 * 悬停节点最后画（压在其它节点之上）。图形逻辑不与 `Graph2d`（Cytoscape.js）归一——已裁定，§4.8。
 */

import type { TFunction } from "i18next";
import { drawConstellationLabel } from "./constellation-labels";
import { paintConstellationLegend } from "./constellation-legend";
import type { ConstellationScene } from "./constellation-scene";
import type { ConstellationViewState } from "./constellation-state";
import type { GraphNode } from "./graph-model";

export interface ConstellationFrameInput {
  /** 逐帧交互状态（`ref` 持有，绘制过程会就地更新命中结果）。 */
  state: ConstellationViewState;
  scene: ConstellationScene;
  isDark: boolean;
  compactLabels: boolean;
  nodeSizeFn?: (node: GraphNode) => number;
  t: TFunction;
  heatLegendLabel?: string;
  heatLegendEndpoints?: [string, string];
  sizeLegendLabel?: string;
}

export function paintConstellationFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  input: ConstellationFrameInput,
): void {
  const { scene, isDark, compactLabels, t } = input;
  const { preparedNodes, linksByNode, linksWithIndices } = scene;
  const s = input.state;

  // 直接使用目标值，无插值动画 — 避免初始化/切换时的飞入效果
  // 平移和缩放瞬间到位，手感由鼠标拖拽和滚轮提供
  s.panX = s.targetPanX;
  s.panY = s.targetPanY;
  s.zoom = s.targetZoom;

  const { W, H, dpr, zoom, panX, panY, mouseX, mouseY, hoverIndex } = s;
  const cx = W / 2 + panX;
  const cy = H / 2 + panY;
  const margin = 60;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(dpr, dpr);

  const bg = isDark ? "#09090b" : "#ffffff";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Screen positions
  const screenX = new Float32Array(preparedNodes.length);
  const screenY = new Float32Array(preparedNodes.length);
  const visible = new Uint8Array(preparedNodes.length);

  for (let i = 0; i < preparedNodes.length; i++) {
    const n = preparedNodes[i];
    const sx = cx + n.wx * zoom;
    const sy = cy + n.wy * zoom;
    screenX[i] = sx;
    screenY[i] = sy;
    visible[i] = sx > -margin && sx < W + margin && sy > -margin && sy < H + margin ? 1 : 0;
  }

  // Hit test for hover
  if (mouseX >= 0 && !s.isDragging) {
    let bestDist = zoom > 1.5 ? 80 : 30;
    let bestIdx = -1;
    for (let i = 0; i < preparedNodes.length; i++) {
      if (!visible[i]) continue;
      const dx = mouseX - screenX[i];
      const dy = mouseY - screenY[i];
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    s.hoverIndex = bestIdx;
  }

  const hoveredLinks = new Set<number>();
  if (hoverIndex >= 0) {
    const myLinks = linksByNode.get(hoverIndex) || [];
    for (const li of myLinks) hoveredLinks.add(li);
  }

  // --- Draw links ---
  const maxLinks = 6000;
  let linksDrawn = 0;

  if (hoverIndex >= 0) {
    // Only draw hovered node's links
    for (const li of hoveredLinks) {
      const link = linksWithIndices[li];
      const ax = screenX[link.a];
      const ay = screenY[link.a];
      const bx = screenX[link.b];
      const by = screenY[link.b];

      ctx.strokeStyle = link.color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5;

      const midX = (ax + bx) / 2 + (by - ay) * 0.08;
      const midY = (ay + by) / 2 - (bx - ax) * 0.08;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(midX, midY, bx, by);
      ctx.stroke();
      linksDrawn++;
    }
    ctx.globalAlpha = 1;
  } else {
    const baseAlpha = 0.5;
    ctx.lineWidth = 0.4;

    for (const link of linksWithIndices) {
      if (linksDrawn >= maxLinks) break;
      const ax = screenX[link.a];
      const ay = screenY[link.a];
      const bx = screenX[link.b];
      const by = screenY[link.b];

      if (
        (ax < -margin && bx < -margin) ||
        (ax > W + margin && bx > W + margin) ||
        (ay < -margin && by < -margin) ||
        (ay > H + margin && by > H + margin)
      )
        continue;

      ctx.strokeStyle = link.color;
      ctx.globalAlpha = baseAlpha;

      const midX = (ax + bx) / 2 + (by - ay) * 0.08;
      const midY = (ay + by) / 2 - (bx - ax) * 0.08;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(midX, midY, bx, by);
      ctx.stroke();
      linksDrawn++;
    }
    ctx.globalAlpha = 1;
  }

  // --- Draw nodes ---
  // Label deconfliction grid. Compact mode shrinks the cell so short labels
  // (e.g. entity names) can pack more densely.
  const GRID_CELL = compactLabels ? 28 : 90;
  const labelGrid = new Set<string>();

  function canPlace(lx: number, ly: number, lw: number, lh: number) {
    const c0 = Math.floor(lx / GRID_CELL);
    const c1 = Math.floor((lx + lw) / GRID_CELL);
    const r0 = Math.floor(ly / GRID_CELL);
    const r1 = Math.floor((ly + lh) / GRID_CELL);
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) if (labelGrid.has(`${c},${r}`)) return false;
    return true;
  }

  function claim(lx: number, ly: number, lw: number, lh: number) {
    const c0 = Math.floor(lx / GRID_CELL);
    const c1 = Math.floor((lx + lw) / GRID_CELL);
    const r0 = Math.floor(ly / GRID_CELL);
    const r1 = Math.floor((ly + lh) / GRID_CELL);
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) labelGrid.add(`${c},${r}`);
  }

  let labelsShown = 0;
  let visibleCount = 0;

  // Draw hovered last (on top)
  const order: number[] = [];
  for (let i = 0; i < preparedNodes.length; i++) {
    if (!visible[i]) continue;
    if (i === hoverIndex) continue;
    order.push(i);
  }
  if (hoverIndex >= 0 && visible[hoverIndex]) order.push(hoverIndex);

  for (const i of order) {
    const n = preparedNodes[i];
    const sx = screenX[i];
    const sy = screenY[i];
    visibleCount++;

    const isHovered = i === hoverIndex;
    const isNeighbor = hoveredLinks.size > 0 && (linksByNode.get(i) || []).some((li: number) => hoveredLinks.has(li));

    // Size varies slightly by link count — subtle range like star magnitudes.
    // When nodeSizeFn is provided (e.g. entities view), it overrides linkCount
    // sizing so dots can scale by an external weight like co-occurrence count.
    const baseR = input.nodeSizeFn ? input.nodeSizeFn(n.node) : 2.5 + Math.min(n.linkCount * 0.15, 2.5);
    const r = Math.max(1.5, baseR * Math.min(zoom, 2));

    // Opacity varies — fewer links = dimmer, more links = brighter
    const baseAlpha = 0.45 + Math.min(n.linkCount * 0.03, 0.5);

    // Dot — star-like: heat-gradient color, varied size & opacity
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = n.heatColor;
    ctx.globalAlpha = isHovered ? 1 : isNeighbor ? 0.95 : hoverIndex >= 0 ? 0.08 : baseAlpha;

    if (isHovered || isNeighbor) {
      ctx.shadowColor = n.heatColor;
      ctx.shadowBlur = isHovered ? 20 : 10;
    }
    ctx.fill();

    // Soft glow halo for brighter stars (high link count)
    if (n.linkCount > 3 && !isHovered && hoverIndex < 0) {
      ctx.beginPath();
      ctx.arc(sx, sy, r * 2, 0, Math.PI * 2);
      ctx.fillStyle = n.heatColor;
      ctx.globalAlpha = 0.06 + Math.min(n.linkCount * 0.005, 0.08);
      ctx.fill();
    }

    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // Label — always use deconfliction grid to prevent overlap
    if (isHovered) {
      // Hovered node always gets a label (skip deconfliction)
      drawConstellationLabel(ctx, n, sx, sy, r, true, true, isDark, zoom);
      labelsShown++;
    } else if (zoom > 1.5) {
      const cardW = Math.min(200, 80 + zoom * 25);
      const cardH = 50;
      const lx = sx - cardW / 2;
      const ly = sy + r + 4;
      if (canPlace(lx, ly, cardW, cardH)) {
        claim(lx, ly, cardW, cardH);
        drawConstellationLabel(ctx, n, sx, sy, r, false, isNeighbor, isDark, zoom);
        labelsShown++;
      }
    } else if (compactLabels || zoom > 0.5 || isNeighbor) {
      // Show inline labels with deconfliction — neighbors included but grid-checked.
      // Compact mode uses a tiny bounding box so short labels pack densely.
      const lw = compactLabels ? 60 : 155;
      const lh = compactLabels ? 12 : 16;
      const lx = sx + r + 5;
      const ly = sy - 8;
      if (canPlace(lx, ly, lw, lh)) {
        claim(lx, ly, lw, lh);
        drawConstellationLabel(ctx, n, sx, sy, r, false, isNeighbor, isDark, zoom);
        labelsShown++;
      }
    }
  }

  paintConstellationLegend(ctx, {
    width: W,
    height: H,
    zoom,
    isDark,
    t,
    heatLegendLabel: input.heatLegendLabel,
    heatLegendEndpoints: input.heatLegendEndpoints,
    sizeLegendLabel: input.sizeLegendLabel,
    stats: { memories: preparedNodes.length, visible: visibleCount, labels: labelsShown, links: linksDrawn },
  });

  ctx.restore();
}
