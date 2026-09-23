/**
 * `Constellation` 的图例层：HUD 统计行、连线类型图例、热度色带图例、节点尺寸图例与操作提示。
 *
 * 为什么从逐帧绘制里分出来：这些画的是「读图用的说明」而不是图本身——位置全部锚在画布四边、
 * 只依赖该帧的计数字面量，既不参与命中测试也不参与标签去重。混在数据绘制里时，
 * 想调整图例位置要先穿过连线与节点的绘制逻辑。
 * 绘制顺序与迁移前一致：它在节点绘制之后、`ctx.restore()` 之前被调用。
 */

import type { TFunction } from "i18next";
import { FONT_BOLD, heatColor, LINK_TYPE_COLORS, MONO } from "./constellation-scene";

export interface ConstellationLegendOptions {
  width: number;
  height: number;
  zoom: number;
  isDark: boolean;
  t: TFunction;
  /** 图例标题与两端文案的覆盖项：`entities` 视图用它们把热度换成「近期度」等别的维度。 */
  heatLegendLabel?: string;
  heatLegendEndpoints?: [string, string];
  sizeLegendLabel?: string;
  /** 该帧实际画出来的四个计数（HUD 行的入参）。 */
  stats: { memories: number; visible: number; labels: number; links: number };
}

export function paintConstellationLegend(ctx: CanvasRenderingContext2D, options: ConstellationLegendOptions): void {
  const { width: W, height: H, zoom, isDark, t, stats } = options;

  // HUD
  ctx.font = MONO;
  ctx.fillStyle = isDark ? "#71717a" : "#71717a";
  ctx.textAlign = "left";
  ctx.fillText(
    t("constellation.hudStats", {
      memories: stats.memories,
      visible: stats.visible,
      labels: stats.labels,
      links: stats.links,
      zoom: zoom.toFixed(2),
    }),
    12,
    H - 12,
  );

  // Legend — link types
  ctx.textAlign = "right";
  let legendX = W - 12;
  ctx.font = FONT_BOLD;
  const linkTypeLabel: Record<string, string> = {
    semantic: t("constellation.linkTypeSemantic"),
    temporal: t("constellation.linkTypeTemporal"),
    entity: t("constellation.linkTypeEntity"),
    causal: t("constellation.linkTypeCausal"),
  };
  for (const [type, color] of Object.entries(LINK_TYPE_COLORS).reverse()) {
    const label = linkTypeLabel[type] ?? type;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = isDark ? "#a1a1aa" : "#52525b";
    ctx.fillText(label, legendX, H - 12);
    legendX -= tw + 4;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(legendX, H - 15, 3, 0, Math.PI * 2);
    ctx.fill();
    legendX -= 14;
  }

  // Heat gradient legend (top-left, below instructions)
  ctx.textAlign = "left";
  ctx.font = FONT_BOLD;
  ctx.fillStyle = isDark ? "#a1a1aa" : "#52525b";
  ctx.fillText((options.heatLegendLabel || t("constellation.legendLinks")).toUpperCase(), 12, 36);
  const [heatLo, heatHi] = options.heatLegendEndpoints || [t("constellation.legendFew"), t("constellation.legendMany")];
  // Size the bar so both endpoint labels fit without overlap (e.g. ISO dates
  // are wider than "few"/"many"). Min 80px keeps the visual weight stable.
  ctx.font = MONO;
  const heatLoW = ctx.measureText(heatLo).width;
  const heatHiW = ctx.measureText(heatHi).width;
  const gradW = Math.max(80, heatLoW + heatHiW + 12);
  for (let gx = 0; gx < gradW; gx++) {
    ctx.fillStyle = heatColor(gx / gradW);
    ctx.fillRect(12 + gx, 42, 1, 6);
  }
  ctx.fillStyle = isDark ? "#a1a1aa" : "#71717a";
  ctx.fillText(heatLo, 12, 60);
  ctx.textAlign = "right";
  ctx.fillText(heatHi, 12 + gradW, 60);

  // Node-size legend — only shown when the caller maps size to a real dimension.
  // Layout: "few • • ● many" so the labels bracket the dots without overlap.
  if (options.sizeLegendLabel) {
    ctx.textAlign = "left";
    ctx.font = FONT_BOLD;
    ctx.fillStyle = isDark ? "#a1a1aa" : "#52525b";
    ctx.fillText(options.sizeLegendLabel.toUpperCase(), 12, 82);
    ctx.font = MONO;
    const labelColor = isDark ? "#a1a1aa" : "#71717a";
    ctx.fillStyle = labelColor;
    const sizeFew = t("constellation.legendFew");
    const sizeMany = t("constellation.legendMany");
    ctx.fillText(sizeFew, 12, 98);
    const fewW = ctx.measureText(sizeFew).width;
    const dotsStart = 12 + fewW + 8;
    const dotColor = isDark ? "#a1a1aa" : "#52525b";
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(dotsStart + 2, 94, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(dotsStart + 14, 94, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(dotsStart + 30, 94, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = labelColor;
    ctx.fillText(sizeMany, dotsStart + 42, 98);
  }

  // Instructions
  ctx.textAlign = "left";
  ctx.font = MONO;
  ctx.fillStyle = isDark ? "#52525b" : "#a1a1aa";
  ctx.fillText(t("constellation.instructions"), 12, 16);
}
