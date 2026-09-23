/**
 * `Constellation` 的标签绘制：单个节点的「卡片」与「行内」两种画法。
 *
 * 单独一层的理由：逐帧绘制里标签是唯一需要**重新排版**的部分（走 Pretext 的 `layoutWithLines`），
 * 与连线/节点的画法在参数与分支上都不重叠；两者的调用点只有一个（绘制层），所以也不额外抽象。
 *
 * 身份稳定性：迁到模块级后它天然是稳定引用。迁移前它靠 `useCallback([], ...)` 固定身份——
 * 绘制循环 `animate` 把它列进了依赖，身份一旦每次渲染都变，动画帧链会被反复取消重启。
 */

import { layoutWithLines } from "@chenglou/pretext";
import { FONT_SMALL, type PreparedNode } from "./constellation-scene";

export function drawConstellationLabel(
  ctx: CanvasRenderingContext2D,
  n: PreparedNode,
  sx: number,
  sy: number,
  r: number,
  isHovered: boolean,
  force: boolean,
  dark: boolean,
  zoom: number,
): void {
  if (zoom > 1.5 || isHovered) {
    // Card mode
    const cardW = Math.min(220, 80 + zoom * 25);
    const textW = cardW - 16;
    const { lines } = layoutWithLines(n.prepared, textW, 15);
    const maxLines = isHovered ? Math.min(lines.length, 5) : Math.min(lines.length, Math.floor(zoom));
    const cardH = 8 + maxLines * 15 + 8;

    const cardX = sx - cardW / 2;
    const cardY = sy + r + 4;

    ctx.fillStyle = isHovered ? (dark ? "#1c1c1e" : "#f4f4f5") : dark ? "rgba(9,9,11,0.92)" : "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 6);
    ctx.fill();

    ctx.strokeStyle = isHovered ? n.color : dark ? "rgba(63,63,70,0.5)" : "rgba(212,212,216,0.6)";
    ctx.lineWidth = isHovered ? 1.5 : 0.5;
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 6);
    ctx.stroke();

    if (isHovered) {
      ctx.shadowColor = n.color;
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.roundRect(cardX, cardY, cardW, cardH, 6);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    ctx.font = FONT_SMALL;
    ctx.fillStyle = isHovered ? (dark ? "#e4e4e7" : "#18181b") : dark ? "#71717a" : "#71717a";
    ctx.textAlign = "left";
    for (let j = 0; j < maxLines; j++) {
      ctx.fillText(lines[j].text, cardX + 8, cardY + 8 + j * 15 + 11);
    }
  } else {
    // Inline label
    ctx.font = FONT_SMALL;
    ctx.fillStyle = isHovered ? (dark ? "#e4e4e7" : "#18181b") : dark ? "#52525b" : "#a1a1aa";
    ctx.globalAlpha = isHovered ? 1 : force ? 0.85 : Math.min(1, (zoom - 0.3) * 2.5);
    ctx.textAlign = "left";
    const text = n.node.label || n.node.id.substring(0, 12);
    const label = text.length > 45 ? `${text.slice(0, 45)}...` : text;
    ctx.fillText(label, sx + r + 5, sy + 4);
    ctx.globalAlpha = 1;
  }
}
