/**
 * `Constellation` 的节点 tooltip：内容重建与跟随定位。
 *
 * 为什么单开一层：tooltip 是这一路里唯一用 **DOM** 而不是 canvas 画的东西——它按悬停节点
 * 拼出多行结构（类型、正文、上下文、实体、时间、证明数、文档、标签、id），
 * 且只在悬停节点变化时重建（否则每帧重建会抖）。混在事件装配里时，鼠标事件只剩几行，
 * 中间却夹着 90 行 DOM 构造。
 * 定位与迁移前一致：先贴指针右下 16px，再夹在画布内（留 12px 边距，最小 4px）。
 */

import type { TFunction } from "i18next";
import type { ConstellationScene } from "./constellation-scene";
import type { ConstellationViewState } from "./constellation-state";

export interface ConstellationTooltipInput {
  tip: HTMLDivElement | null;
  scene: ConstellationScene;
  state: ConstellationViewState;
  isDark: boolean;
  t: TFunction;
  /** 指针在画布内的坐标（`mousemove` 里已减掉 canvas 的 rect）。 */
  mouse: { x: number; y: number };
}

export function updateConstellationTooltip(input: ConstellationTooltipInput): void {
  const { tip, scene, state: s, isDark, t, mouse } = input;
  if (!tip) return;
  const idx = s.hoverIndex;

  if (idx < 0 || s.isDragging) {
    tip.style.display = "none";
    s.prevHoverIndex = -1;
    return;
  }

  const node = scene.preparedNodes[idx]?.node;
  if (!node) {
    tip.style.display = "none";
    return;
  }

  // Only rebuild innerHTML when the hovered node changes
  if (idx !== s.prevHoverIndex) {
    s.prevHoverIndex = idx;
    const meta = node.metadata as Record<string, unknown> | undefined;
    const fullText = (meta?.text as string) || node.label || node.id;
    const entities: string[] = meta?.entities
      ? String(meta.entities)
          .split(",")
          .map((e: string) => e.trim())
          .filter(Boolean)
      : [];
    const nodeColor = scene.preparedNodes[idx].heatColor;
    const linkCount = scene.preparedNodes[idx].linkCount;
    const factType = (meta?.fact_type as string) || node.group || "memory";
    const context = meta?.context && meta.context !== "N/A" ? (meta.context as string) : null;
    const tags: string[] = Array.isArray(meta?.tags) ? (meta.tags as string[]) : [];
    const occurredStart = (meta?.occurred_start as string) || null;
    const occurredEnd = (meta?.occurred_end as string) || null;
    const mentionedAt = (meta?.mentioned_at as string) || null;
    const proofCount = (meta?.proof_count as number) || null;
    const documentId = (meta?.document_id as string) || null;

    const muted = isDark ? "#a1a1aa" : "#71717a";
    const addLine = (label: string, value: string) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;align-items:baseline;gap:12px";
      const key = document.createElement("span");
      key.style.cssText = `font-size:10px;color:${muted};text-transform:uppercase`;
      key.textContent = label;
      const content = document.createElement("span");
      content.style.cssText = "font-size:12px;text-align:right;overflow-wrap:anywhere";
      content.textContent = value;
      row.append(key, content);
      tip.append(row);
    };

    tip.replaceChildren();
    const heading = document.createElement("div");
    heading.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px";
    const badge = document.createElement("span");
    badge.style.cssText = `font-size:10px;font-weight:600;color:${nodeColor}`;
    badge.textContent = factType;
    const links = document.createElement("span");
    links.style.cssText = `font-size:10px;color:${muted}`;
    links.textContent = t("constellation.tooltipLinks", { count: linkCount });
    heading.append(badge, links);
    const text = document.createElement("div");
    text.style.cssText = "font-size:12px;line-height:1.6;margin-bottom:8px;overflow-wrap:anywhere";
    text.textContent = fullText;
    tip.append(heading, text);
    if (context) addLine(t("constellation.tooltipContext"), context);
    if (entities.length) addLine(t("constellation.tooltipEntities"), entities.join(", "));
    if (occurredStart)
      addLine(t("constellation.tooltipOccurred"), occurredEnd ? `${occurredStart} — ${occurredEnd}` : occurredStart);
    if (mentionedAt) addLine(t("constellation.tooltipMentioned"), mentionedAt);
    if (proofCount) addLine(t("constellation.tooltipProofs"), String(proofCount));
    if (documentId) addLine(t("constellation.tooltipDocument"), documentId);
    if (tags.length) addLine(t("constellation.tooltipTags"), tags.map((tag) => `#${tag}`).join(" "));
    addLine(t("constellation.tooltipId"), node.id);
  }

  tip.style.display = "block";
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  const tx = Math.min(mouse.x + 16, s.W - tipW - 12);
  const ty = Math.min(mouse.y + 16, s.H - tipH - 12);
  tip.style.left = `${Math.max(4, tx)}px`;
  tip.style.top = `${Math.max(4, ty)}px`;
}
