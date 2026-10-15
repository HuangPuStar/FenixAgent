/**
 * 会话时间线渲染窗口 —— 纯计算层（无 React、无 DOM）。
 *
 * 背景：超长上下文下时间线的 DOM 规模等于消息条数，流式期间每次 chunk 都要整条链重渲染。
 * 本模块只回答「渲染哪些块」，**不碰数据**：条目始终完整进 Y.Doc、完整投影为 `ThreadEntry[]`，
 * 窗口只决定渲染集合（见 `docs/arch/19-yjs-chat-streaming.md` §5.7）。
 *
 * 为什么以**渲染块**为单位而不是条目：`buildChatRenderBlocks` 已按「活动链」把相邻工具调用与
 * 纯思考条目并成一个视觉连续体，切口落在链中间会打断工具轨的竖线、丢掉链首的 `-mt-3.5` 对齐补偿；
 * 且块内条目本就是一个连续区间，块对齐 ⇒ 条目对齐 ⇒ 绝不截断单条消息。
 *
 * **块必须先经 `splitOversizedBlocks` 切到预算内**：预算只约束块的个数，块自身的条目数是构造成来的
 * ——相邻工具调用会并成一个 `tool_group`，一次压测式长跑就是一块数千条目，窗口会整体收下它、
 * 首屏退回全量渲染。切分保证「每个显示块 ≤ 预算」，窗口的条目上界才真正成立。
 *
 * 放在 `view/internal/` 而不是 `lib/`：导出面按真实消费点收敛，本模块目前只有窗口 hook 与测试消费，
 * 不进入包 barrel。
 */

import type { ChatRenderBlock, ChatRenderItem } from "../../lib/chat-render-layout";

/** 窗口目标体量（条目数）。实际渲染量可略高：块是原子单位，预算不足时整块让位。 */
export const CHAT_WINDOW_ENTRY_BUDGET = 100;
/**
 * 有进行中的响应时的**浏览深度**上界（条目数）。
 *
 * 此时窗口尾部恒定锚定最新块（进行中的条目必须始终在渲染集合里，不能被滑出去），于是「向上滑入
 * 更早条目」只能让窗口变长：这条上界约束的是能往回滑多远，不是窗口的实时体量。
 *
 * **刻意不做「超限就把窗口顶部裁掉」**：裁剪发生在数据到达时（不是用户滚动时），没有可用来做锚定
 * 补偿的前后测量点，用户眼皮底下的内容会被搬走 —— 那正是本模块要避免的跳动。因此浏览期间窗口
 * 随新条目一起变长，回到最新（或本轮结束）时才收回预算窗口。
 */
export const CHAT_WINDOW_LIVE_ENTRY_CEILING = 400;
/** 单次滑动搬动的条目数：太小会让一次长滚动触发多轮渲染，太大则一次塞进过多内容。 */
export const CHAT_WINDOW_SLIDE_ENTRIES = 12;
/** 距滚动区顶部多少像素内触发向更早滑动。 */
export const CHAT_WINDOW_TOP_TRIGGER_PX = 160;
/**
 * 距滚动区底部多少像素内提前向更新滑动。
 *
 * 刻意大于 `use-stick-to-bottom` 的 70px 贴底判定：贴底判定是「回到最新」的语义（窗口直接跳回最新），
 * 提前量让正常向下阅读走逐块滑入，不会一步跳到最新。
 */
export const CHAT_WINDOW_BOTTOM_PRELOAD_PX = 400;
/** 距滚动区底部多少像素内视为「已回到底部」（贴底判定的收窄版，避免依赖库状态的一帧延迟）。 */
export const CHAT_WINDOW_AT_BOTTOM_PX = 24;
/** 定位跳转时在目标块之前保留的上下文块数。 */
export const CHAT_WINDOW_REVEAL_LEAD_BLOCKS = 4;

/** 渲染块上的窗口下标属性：窗口 hook 靠它把「块下标」换回可测量的 DOM 元素。 */
export const CHAT_BLOCK_INDEX_ATTRIBUTE = "data-chat-block-index";

/** 窗口状态：`tail` 跟随最新（尾部锚定），`free` 由用户滚动停在历史位置。 */
export type ChatWindowMode = "tail" | "free";

/** 窗口区间（块下标，`end` 不含）。 */
export interface ChatWindowRange {
  start: number;
  end: number;
  /** 窗口尾部是否已锚定在最新块。 */
  atTail: boolean;
  /** 向更早滑动能到达的下界（有进行中的响应时受 `CHAT_WINDOW_LIVE_ENTRY_CEILING` 约束）。 */
  minStart: number;
}

/** 一次滚动事件该做的窗口动作。 */
export type ChatWindowScrollIntent =
  | { type: "none" }
  | { type: "prepend"; nextStart: number; pivotIndex: number }
  | { type: "slideDown"; nextStart: number; pivotIndex: number }
  | { type: "restoreTail" };

/** 渲染项覆盖的条目数（工具组一块覆盖多条工具调用）。 */
export function countRenderItemEntries(item: ChatRenderItem): number {
  return item.type === "tool_group" ? item.entries.length : 1;
}

/** 渲染块覆盖的条目数。 */
export function countRenderBlockEntries(block: ChatRenderBlock): number {
  return block.type === "activity_chain"
    ? block.items.reduce((sum, item) => sum + countRenderItemEntries(item), 0)
    : countRenderItemEntries(block.item);
}

/**
 * 把「单块覆盖条目数超过预算」的大块切成若干显示块（对齐到整项 / 整条目）。
 *
 * **为什么必须切**：预算只约束块的**个数**，块自身的条目数是构造成来的——相邻工具调用会并成一个
 * `tool_group`，一次压测式长跑（数千次连续调用 + 纯思考条目）就是**一块数千条目**。窗口的
 * 「宁可少渲染一块」规则遇到这种块会整体收下，首屏直接退回全量渲染（实测 4636 条会话尾部的
 * 连续工具链：一块覆盖 3971 条，首屏 55648 个 DOM 节点）。
 *
 * **切法**：先按「项」累积条目分组（一个项 = 一条消息或一个工具组），只有工具组自身超预算时
 * 才按条目切开——工具行本就是逐条渲染，切开不截断任何一条消息。切完每个显示块都不超过预算，
 * 于是窗口的条目上界重新成立。
 *
 * **代价**：超大块会出现极小的视觉接缝（相邻工具组之间多 6px 间距、活动链各自的竖线收口）；
 * 只有单块超过预算的会话才有接缝，普通会话的块列表逐字不变（对象原样引用）。
 */
export function splitOversizedBlocks(blocks: readonly ChatRenderBlock[], budget: number): ChatRenderBlock[] {
  const limit = Math.max(1, Math.floor(budget));
  const result: ChatRenderBlock[] = [];
  for (const block of blocks) {
    if (countRenderBlockEntries(block) <= limit) {
      result.push(block);
      continue;
    }
    const items = block.type === "activity_chain" ? block.items : [block.item];
    for (const chunk of chunkItemsByEntries(items, limit)) {
      result.push(
        block.type === "activity_chain" ? { type: "activity_chain", items: chunk } : { type: "item", item: chunk[0]! },
      );
    }
  }
  return result;
}

/** 按累积条目数把项序列切成若干组，每组不超过预算（单项超预算时按条目再切）。 */
function chunkItemsByEntries(items: readonly ChatRenderItem[], limit: number): ChatRenderItem[][] {
  const chunks: ChatRenderItem[][] = [];
  let current: ChatRenderItem[] = [];
  let entries = 0;
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    entries = 0;
  };
  for (const item of items) {
    const itemEntries = countRenderItemEntries(item);
    if (itemEntries <= limit) {
      if (entries > 0 && entries + itemEntries > limit) flush();
      current.push(item);
      entries += itemEntries;
      continue;
    }
    // 走到这里只可能是工具组自身超预算（条目型项恒为 1 条）：按条目切开，逐条仍是完整的工具行。
    flush();
    if (item.type !== "tool_group") {
      chunks.push([item]);
      continue;
    }
    for (const chunk of chunkEntries(item.entries, limit)) {
      chunks.push([{ type: "tool_group", entries: chunk, density: "activity" }]);
    }
  }
  flush();
  return chunks;
}

/** 把条目按固定上限切段（保留顺序，不丢不改）。 */
function chunkEntries<T>(entries: readonly T[], limit: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < entries.length; index += limit) {
    chunks.push(entries.slice(index, index + limit));
  }
  return chunks;
}

/** 从 `start` 向更早方向搬动至少 `targetEntries` 条（至少一块，不越过 `minStart`）。 */
export function stepStartBackward(
  blocks: readonly ChatRenderBlock[],
  start: number,
  minStart: number,
  targetEntries: number,
): number {
  let next = start;
  let moved = 0;
  while (next > minStart && moved < targetEntries) {
    next -= 1;
    moved += countRenderBlockEntries(blocks[next]!);
  }
  return next;
}

/** 从 `start` 向更新方向搬动至少 `targetEntries` 条（不越过尾部，且至少留一块重叠）。 */
export function stepStartForward(
  blocks: readonly ChatRenderBlock[],
  start: number,
  end: number,
  targetEntries: number,
): number {
  let next = start;
  let moved = 0;
  while (next + 1 < end && moved < targetEntries) {
    moved += countRenderBlockEntries(blocks[next]!);
    next += 1;
  }
  return next;
}

/**
 * 从尾部向前累计条目，返回最新窗口的起始块下标。
 *
 * 预算不足时停止在**整块边界**上（第一块始终收入）：宁可少渲染一块，也不把一条消息或一串工具调用
 * 切成两半。因为调用方已用 `splitOversizedBlocks` 把超大块切到预算内，这里的「让位」最多让出一块
 * （≤ 预算），不会再出现「一块吃掉整个预算」的退化。
 */
export function computeTailWindowStart(blocks: readonly ChatRenderBlock[], budget: number): number {
  let start = blocks.length;
  let entries = 0;
  while (start > 0) {
    const blockEntries = countRenderBlockEntries(blocks[start - 1]!);
    if (entries > 0 && entries + blockEntries > budget) break;
    entries += blockEntries;
    start -= 1;
  }
  return start;
}

/**
 * 从 `start` 向前累计条目，返回窗口结束下标（不含）。
 *
 * 与 `computeTailWindowStart` 同一套预算规则，保证 `computeWindowEnd(computeTailWindowStart(x))`
 * 回到列表尾部：中间不出现「被跳过的块」，窗口始终是连续区间。
 */
export function computeWindowEnd(blocks: readonly ChatRenderBlock[], start: number, budget: number): number {
  const total = blocks.length;
  let end = Math.min(start, total);
  let entries = 0;
  while (end < total) {
    const blockEntries = countRenderBlockEntries(blocks[end]!);
    if (entries > 0 && entries + blockEntries > budget) break;
    entries += blockEntries;
    end += 1;
  }
  return end;
}

/**
 * 由窗口状态解析出实际区间。
 *
 * - `tail`：尾部锚定最新块（新内容到达时自动前移，最旧的一块滑出）。
 * - `free`：滑动窗口；起点被夹在 `[0, tailStart]`，夹到 `tailStart` 即等价于回到 `tail`。
 * - 有进行中的响应（`live`）时结束下标恒为列表尾部：进行中的条目不允许被滑出去。此时 `minStart`
 *   是**浏览深度的下界**（前插到此为止），起点本身不再被上抬 —— 静默裁剪会让可见区域跳动。
 */
export function resolveChatWindow(
  blocks: readonly ChatRenderBlock[],
  state: { mode: ChatWindowMode; start: number; live: boolean },
): ChatWindowRange {
  const total = blocks.length;
  const minStart = state.live ? computeTailWindowStart(blocks, CHAT_WINDOW_LIVE_ENTRY_CEILING) : 0;
  if (total === 0) return { start: 0, end: 0, atTail: true, minStart };
  const tailStart = computeTailWindowStart(blocks, CHAT_WINDOW_ENTRY_BUDGET);
  if (state.mode === "tail") return { start: tailStart, end: total, atTail: true, minStart };
  const start = Math.max(0, Math.min(state.start, tailStart));
  if (start >= tailStart) return { start: tailStart, end: total, atTail: true, minStart };
  return {
    start,
    end: state.live ? total : computeWindowEnd(blocks, start, CHAT_WINDOW_ENTRY_BUDGET),
    atTail: false,
    minStart,
  };
}

/**
 * 由一次滚动的位置解析窗口动作。
 *
 * 优先级：回到底部（恢复最新窗口）→ 顶部前插（滑入更早）→ 底部提前滑入（滑入更新）。
 * `pivotIndex` 是滑动前后都存在的那一块：调用方在提交前记下它的视口位置，提交后按位移反向补偿
 * `scrollTop`，可见区域因此不跳动（见 `resolveAnchoredScrollTop`）。
 */
export function resolveScrollIntent(input: {
  blocks: readonly ChatRenderBlock[];
  range: ChatWindowRange;
  atBottom: boolean;
  scrollTop: number;
  distanceToBottom: number;
}): ChatWindowScrollIntent {
  const { blocks, range } = input;
  if (input.atBottom) return range.atTail ? { type: "none" } : { type: "restoreTail" };
  if (input.scrollTop <= CHAT_WINDOW_TOP_TRIGGER_PX && range.start > range.minStart) {
    // 按条目而不是按块数搬：显示块可以覆盖 100 条（工具链切片），按块数搬会一次塞进上千条。
    const nextStart = stepStartBackward(blocks, range.start, range.minStart, CHAT_WINDOW_SLIDE_ENTRIES);
    if (nextStart === range.start) return { type: "none" };
    // 前插后旧窗口首块仍在窗口内（预算单调：更早的起点只会走到更靠后的结束下标）。
    return { type: "prepend", nextStart, pivotIndex: range.start };
  }
  if (input.distanceToBottom <= CHAT_WINDOW_BOTTOM_PRELOAD_PX && !range.atTail) {
    const tailStart = computeTailWindowStart(blocks, CHAT_WINDOW_ENTRY_BUDGET);
    // 上界取「尾部窗口起点」与「留一块重叠」的较小者，锚点因此总有共同元素。
    const stepped = stepStartForward(blocks, range.start, range.end, CHAT_WINDOW_SLIDE_ENTRIES);
    const nextStart = Math.min(tailStart, stepped, range.end - 1);
    if (nextStart === range.start) return { type: "none" };
    return { type: "slideDown", nextStart, pivotIndex: nextStart };
  }
  return { type: "none" };
}

/**
 * 滚动锚定补偿：滑动前后取同一块的视口 `top`，位移多少就把 `scrollTop` 反向补多少。
 *
 * 结果与「内容在窗口内插入/移除的高度」无关，插上、裁下、两头同时动都能精确抵消。
 */
export function resolveAnchoredScrollTop(input: {
  scrollTop: number;
  anchorTopBefore: number;
  anchorTopAfter: number;
}): number {
  return input.scrollTop + (input.anchorTopAfter - input.anchorTopBefore);
}

/**
 * 渲染量不足以填满视口时是否还要前插。
 *
 * 触发场景：预算刚好卡在一个大块前面，窗口只装得下很少的条目，内容比视口还短 —— 此时滚动区
 * 没有可滚动内容、永远不会派发滚动事件，滚动触发的那两条路径全都到不了，用户会卡在「只能看到
 * 最后几条」。这里补一条与滚动无关的兜底：每次提交后检查渲染高度是否够撑出一屏，不够就继续前插
 * （直到 `minStart`，因此有界、可自行收敛）。
 *
 * 只看渲染高度与视口高度，不看 `scrollTop`：滚到底部时「视口下方的剩余高度」为 0，
 * 用它做判据会让「回到底部」变成无限前插。`clientHeight <= 0`（隐藏容器、无布局环境）不动作：
 * 看不见的容器不需要更多内容。
 */
export function resolveViewportFillIntent(input: {
  blocks: readonly ChatRenderBlock[];
  range: ChatWindowRange;
  scrollHeight: number;
  clientHeight: number;
}): ChatWindowScrollIntent {
  const { blocks, range } = input;
  if (input.clientHeight <= 0 || range.start <= range.minStart) return { type: "none" };
  if (input.scrollHeight > input.clientHeight + CHAT_WINDOW_TOP_TRIGGER_PX) return { type: "none" };
  const nextStart = stepStartBackward(blocks, range.start, range.minStart, CHAT_WINDOW_SLIDE_ENTRIES);
  if (nextStart === range.start) return { type: "none" };
  return { type: "prepend", nextStart, pivotIndex: range.start };
}

/** 查找条目所属的渲染块下标；不在时间线里时返回 -1。 */
export function findBlockIndexByEntryId(blocks: readonly ChatRenderBlock[], entryId: string): number {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const found =
      block.type === "activity_chain"
        ? block.items.some((item) => itemContainsEntry(item, entryId))
        : itemContainsEntry(block.item, entryId);
    if (found) return index;
  }
  return -1;
}

/** 渲染项是否覆盖该条目 id（工具条目按 `toolCall.id` 命中，与节点 id 口径一致）。 */
function itemContainsEntry(item: ChatRenderItem, entryId: string): boolean {
  if (item.type === "tool_group") return item.entries.some((entry) => entry.toolCall.id === entryId);
  return item.entry.type === "tool_call" ? item.entry.toolCall.id === entryId : item.entry.id === entryId;
}
