import { describe, expect, test } from "bun:test";
import { buildChatRenderBlocks, type ChatRenderBlock } from "../chat/lib/chat-render-layout";
import type { AssistantMessageEntry, ThreadEntry, ToolCallEntry } from "../chat/types";
import {
  CHAT_WINDOW_ENTRY_BUDGET,
  CHAT_WINDOW_LIVE_ENTRY_CEILING,
  CHAT_WINDOW_SLIDE_ENTRIES,
  computeTailWindowStart,
  computeWindowEnd,
  countRenderBlockEntries,
  findBlockIndexByEntryId,
  resolveAnchoredScrollTop,
  resolveChatWindow,
  resolveScrollIntent,
  resolveViewportFillIntent,
  splitOversizedBlocks,
} from "../chat/view/internal/chat-window";

/**
 * 时间线渲染滑动窗口的纯计算契约（`web/chat/view/internal/chat-window.ts`）。
 *
 * 覆盖三件在 DOM 里测不动、却决定「超长上下文能不能只看 100 条」的事：
 * 1. 区间计算——尾部窗口/前插/后滑的体量与块对齐（边缘元素完整性由此保证）；
 * 2. 滑动意图——滚动位置到窗口动作的映射，以及「锚点块在滑动前后都存在」这一前提；
 * 3. 锚定补偿算式——可见区域不跳动的定义（正负号一旦写反，滑动会跳一屏）。
 *
 * 全程无 DOM 依赖（被测模块只 import 类型），因此不引入 happy-dom 引导。
 */

function userMessage(id: string): ThreadEntry {
  return { type: "user_message", id, content: `输入 ${id}` };
}

function assistantMessage(id: string): AssistantMessageEntry {
  return { type: "assistant_message", id, chunks: [{ type: "message", text: `正文 ${id}` }] };
}

function toolCall(id: string): ToolCallEntry {
  return { type: "tool_call", toolCall: { id, title: "Read", kind: "read-file", status: "complete" } };
}

/** 交替的用户/助手消息：每条各占一个渲染块，便于把「条目数」与「块数」分开断言。 */
function alternatingMessages(count: number, prefix = "m"): ThreadEntry[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? userMessage(`${prefix}-${index}`) : assistantMessage(`${prefix}-${index}`),
  );
}

/** 窗口覆盖的条目数——「约 100 条」这句承诺的度量。 */
function coveredEntries(blocks: readonly ThreadEntry[], start: number, end: number): number {
  const renderBlocks = buildChatRenderBlocks(blocks);
  return renderBlocks.slice(start, end).reduce((sum, block) => sum + countRenderBlockEntries(block), 0);
}

describe("chat 时间线窗口：区间计算", () => {
  // 超长会话的尾部窗口只覆盖预算内的条目，且起点落在块边界上（不是条目边界）。
  test("尾部窗口按整块对齐到条目预算", () => {
    const blocks = buildChatRenderBlocks(alternatingMessages(300));
    const start = computeTailWindowStart(blocks, CHAT_WINDOW_ENTRY_BUDGET);

    expect(coveredEntries(alternatingMessages(300), start, blocks.length)).toBe(CHAT_WINDOW_ENTRY_BUDGET);
    expect(resolveChatWindow(blocks, { mode: "tail", start: 0, live: false })).toEqual({
      start,
      end: 300,
      atTail: true,
      minStart: 0,
    });
  });

  // 活动链是一整块：预算装不下时整块让位，绝不把工具链切成两半（边缘元素完整性）。
  test("预算不足时整块让位，活动链不被截断", () => {
    const chain = Array.from({ length: 60 }, (_, index) => toolCall(`t-${index}`));
    const entries = [...alternatingMessages(60, "head"), ...alternatingMessages(50, "middle"), ...chain];
    const blocks = buildChatRenderBlocks(entries);
    const start = computeTailWindowStart(blocks, CHAT_WINDOW_ENTRY_BUDGET);
    const window = blocks.slice(start);

    // 尾部是 60 条工具链 + 40 条消息 = 预算刚好用满；第 41 条消息整条让位。
    expect(window.reduce((sum, block) => sum + countRenderBlockEntries(block), 0)).toBe(CHAT_WINDOW_ENTRY_BUDGET);
    // 切口落在消息与活动链之间，链内 60 条一条不少。
    expect(window[0]?.type).toBe("item");
    const chains = window.filter((block) => block.type === "activity_chain");
    expect(chains).toHaveLength(1);
    expect(chains[0] ? countRenderBlockEntries(chains[0]) : 0).toBe(60);
    expect(chains[0]?.items[0]?.type === "tool_group" ? chains[0].items[0].entries.length : 0).toBe(60);
    // 窗口是原列表的连续切片：块对象原样引用，不存在半块。
    expect(window.every((block) => blocks.includes(block))).toBe(true);
  });

  // free 模式：窗口停在历史位置时尾部与最新解耦（窗口变小的同时，最新块不在渲染集合里）。
  test("free 模式窗口与最新解耦且体量受控", () => {
    const blocks = buildChatRenderBlocks(alternatingMessages(300));
    const range = resolveChatWindow(blocks, { mode: "free", start: 0, live: false });

    expect(range).toEqual({ start: 0, end: CHAT_WINDOW_ENTRY_BUDGET, atTail: false, minStart: 0 });
    expect(computeWindowEnd(blocks, 0, CHAT_WINDOW_ENTRY_BUDGET)).toBe(range.end);
  });

  // 有进行中的响应时尾部恒锚定最新块：流式条目永远不会被滑出渲染集合。
  test("live 时尾部锚定，浏览深度受上界约束", () => {
    const blocks = buildChatRenderBlocks(alternatingMessages(600));
    const floor = computeTailWindowStart(blocks, CHAT_WINDOW_LIVE_ENTRY_CEILING);
    const browsing = resolveChatWindow(blocks, { mode: "free", start: floor, live: true });

    expect(floor).toBe(200);
    expect(browsing).toEqual({ start: floor, end: 600, atTail: false, minStart: floor });
    // 上界只约束「能往回滑多远」：到了下界就不再前插。
    expect(
      resolveScrollIntent({ blocks, range: browsing, atBottom: false, scrollTop: 0, distanceToBottom: 4000 }),
    ).toEqual({ type: "none" });
    // 更早的起点不被静默抬走（裁剪发生在数据到达时，会让可见区域跳动），窗口随之变长。
    expect(resolveChatWindow(blocks, { mode: "free", start: 150, live: true })).toEqual({
      start: 150,
      end: 600,
      atTail: false,
      minStart: floor,
    });
    // 同一状态在无进行中响应时回到预算窗口（尾部可以滑出去了）。
    expect(resolveChatWindow(blocks, { mode: "free", start: floor, live: false }).end).toBe(
      floor + CHAT_WINDOW_ENTRY_BUDGET,
    );
  });

  // 空时间线与单块超预算都不能算出空窗口（渲染层会因此什么都看不到）。
  test("空时间线与超预算单块都有非空窗口", () => {
    expect(resolveChatWindow([], { mode: "free", start: 10, live: false })).toEqual({
      start: 0,
      end: 0,
      atTail: true,
      minStart: 0,
    });

    const hugeChain = buildChatRenderBlocks(Array.from({ length: 240 }, (_, index) => toolCall(`huge-${index}`)));
    const range = resolveChatWindow(hugeChain, { mode: "tail", start: 0, live: false });
    expect(range).toEqual({ start: 0, end: 1, atTail: true, minStart: 0 });
  });
});

describe("chat 时间线窗口：滑动意图", () => {
  const blocks = buildChatRenderBlocks(alternatingMessages(300));
  const scrolled = resolveChatWindow(blocks, { mode: "free", start: 150, live: false });

  // 顶部前插：滑入更早条目，锚点用旧窗口首块（滑动后仍在窗口内）。
  test("接近顶部时前插更早的块", () => {
    const intent = resolveScrollIntent({
      blocks,
      range: scrolled,
      atBottom: false,
      scrollTop: 20,
      distanceToBottom: 4000,
    });

    expect(intent).toEqual({
      type: "prepend",
      nextStart: 150 - CHAT_WINDOW_SLIDE_ENTRIES,
      pivotIndex: 150,
    });
    if (intent.type !== "prepend") throw new Error("expected prepend");
    const slid = resolveChatWindow(blocks, { mode: "free", start: intent.nextStart, live: false });
    expect(slid.start).toBeLessThanOrEqual(intent.pivotIndex);
    expect(slid.end).toBeGreaterThan(intent.pivotIndex);
  });

  // 底部提前滑入：接近底部就先搬一块，正常向下阅读不会一步跳到最新。
  test("接近底部时提前滑入更新的块", () => {
    const intent = resolveScrollIntent({
      blocks,
      range: scrolled,
      atBottom: false,
      scrollTop: 4000,
      distanceToBottom: 200,
    });

    expect(intent).toEqual({
      type: "slideDown",
      nextStart: 150 + CHAT_WINDOW_SLIDE_ENTRIES,
      pivotIndex: 150 + CHAT_WINDOW_SLIDE_ENTRIES,
    });
    if (intent.type !== "slideDown") throw new Error("expected slideDown");
    const slid = resolveChatWindow(blocks, { mode: "free", start: intent.nextStart, live: false });
    expect(slid.start).toBe(intent.pivotIndex);
    expect(slid.end).toBeGreaterThan(intent.pivotIndex);
  });

  // 回到底部才恢复最新窗口；已是最新窗口时什么都不做（避免自我触发）。
  test("贴底恢复最新窗口，已锚定尾部则不动", () => {
    expect(
      resolveScrollIntent({ blocks, range: scrolled, atBottom: true, scrollTop: 9000, distanceToBottom: 4 }),
    ).toEqual({
      type: "restoreTail",
    });
    const tail = resolveChatWindow(blocks, { mode: "tail", start: 0, live: false });
    expect(resolveScrollIntent({ blocks, range: tail, atBottom: true, scrollTop: 9000, distanceToBottom: 4 })).toEqual({
      type: "none",
    });
  });

  // 中部滚动、以及已到达向更早滑动下界时都不动窗口：避免每帧重排整条时间线。
  test("非边缘位置与滑动下界都不触发窗口动作", () => {
    expect(
      resolveScrollIntent({ blocks, range: scrolled, atBottom: false, scrollTop: 900, distanceToBottom: 900 }),
    ).toEqual({
      type: "none",
    });
    const atFloor = resolveChatWindow(blocks, { mode: "free", start: 0, live: false });
    expect(
      resolveScrollIntent({ blocks, range: atFloor, atBottom: false, scrollTop: 0, distanceToBottom: 4000 }),
    ).toEqual({
      type: "none",
    });
  });

  // 内容短到不可滚动时永远不会派发滚动事件，兜底规则负责继续前插；无布局环境与下界不动作。
  test("渲染量填不满视口时兜底前插", () => {
    expect(resolveViewportFillIntent({ blocks, range: scrolled, scrollHeight: 120, clientHeight: 600 })).toEqual({
      type: "prepend",
      nextStart: 150 - CHAT_WINDOW_SLIDE_ENTRIES,
      pivotIndex: 150,
    });
    expect(resolveViewportFillIntent({ blocks, range: scrolled, scrollHeight: 0, clientHeight: 0 })).toEqual({
      type: "none",
    });
    expect(resolveViewportFillIntent({ blocks, range: scrolled, scrollHeight: 9000, clientHeight: 600 })).toEqual({
      type: "none",
    });
    const atFloor = resolveChatWindow(blocks, { mode: "free", start: 0, live: false });
    expect(resolveViewportFillIntent({ blocks, range: atFloor, scrollHeight: 120, clientHeight: 600 })).toEqual({
      type: "none",
    });
  });
});

describe("chat 时间线窗口：超大块的切分（首屏上界的根因守卫）", () => {
  /**
   * 压测式长跑：常规轮次之后跟一串连续工具调用。
   *
   * 相邻工具调用会被 `buildChatRenderItems` 并成**一个** `tool_group`，因此尾部是一块覆盖
   * 数千条目的活动链 —— 这正是「首次进入像全量加载」的根因：块粒度预算遇到这种块会整体收下。
   */
  function stressSession(turns: number, perTurn: number, tailTools: number): ThreadEntry[] {
    const entries: ThreadEntry[] = [];
    for (let turn = 0; turn < turns; turn += 1) {
      entries.push(userMessage(`u-${turn}`), assistantMessage(`a-${turn}`));
      for (let index = 0; index < perTurn; index += 1) entries.push(toolCall(`t-${turn}-${index}`));
    }
    for (let index = 0; index < tailTools; index += 1) entries.push(toolCall(`tail-${index}`));
    return entries;
  }

  /** 从块列表还原出窗口覆盖的条目（按渲染顺序展平）。 */
  function flattenEntries(blocks: readonly ChatRenderBlock[]): ThreadEntry[] {
    const flattened: ThreadEntry[] = [];
    for (const block of blocks) {
      const items = block.type === "activity_chain" ? block.items : [block.item];
      for (const item of items) {
        if (item.type === "tool_group") flattened.push(...item.entries);
        else flattened.push(item.entry);
      }
    }
    return flattened;
  }

  // 单块数千条目的会话必须先切成预算内的显示块，否则窗口的条目上界形同虚设（首屏 3971 条 / 55648 节点）。
  test("超大活动链切成预算内的显示块", () => {
    const entries = stressSession(40, 15, 3956);
    const raw = buildChatRenderBlocks(entries);
    // 未切之前：尾部就是一个覆盖近四千条目的巨块。
    expect(countRenderBlockEntries(raw.at(-1)!)).toBeGreaterThan(CHAT_WINDOW_ENTRY_BUDGET * 30);

    const split = splitOversizedBlocks(raw, CHAT_WINDOW_ENTRY_BUDGET);
    expect(split.every((block) => countRenderBlockEntries(block) <= CHAT_WINDOW_ENTRY_BUDGET)).toBe(true);
    // 条目不增不减、顺序不变：切分只改分组，不碰数据。
    expect(flattenEntries(split)).toEqual(entries);
    // 大于预算的块才新建对象；预算内的块原样引用（普通会话的块列表逐字不变）。
    const small = buildChatRenderBlocks(alternatingMessages(300));
    expect(splitOversizedBlocks(small, CHAT_WINDOW_ENTRY_BUDGET)).toEqual(small);
  });

  // 切分之后尾部窗口必须落回预算内，并覆盖源条目的连续后缀（不截断、不重复）。
  test("切分后尾部窗口不超过预算且是连续后缀", () => {
    const entries = stressSession(40, 15, 3956);
    const blocks = splitOversizedBlocks(buildChatRenderBlocks(entries), CHAT_WINDOW_ENTRY_BUDGET);
    const range = resolveChatWindow(blocks, { mode: "tail", start: 0, live: false });
    const window = flattenEntries(blocks.slice(range.start, range.end));

    expect(window.length).toBeLessThanOrEqual(CHAT_WINDOW_ENTRY_BUDGET);
    expect(window).toEqual(entries.slice(entries.length - window.length));
  });
});

describe("chat 时间线窗口：锚定与定位", () => {
  // 锚定补偿的定义：参考块在视口里下移多少，scrollTop 就加多少；上移则反向减。
  test("锚定补偿与参考块位移等量反向", () => {
    expect(resolveAnchoredScrollTop({ scrollTop: 1000, anchorTopBefore: 200, anchorTopAfter: 460 })).toBe(1260);
    expect(resolveAnchoredScrollTop({ scrollTop: 1000, anchorTopBefore: 460, anchorTopAfter: 200 })).toBe(740);
    expect(resolveAnchoredScrollTop({ scrollTop: 1000, anchorTopBefore: 200, anchorTopAfter: 200 })).toBe(1000);
  });

  // 定位跳转要按 id 找到「块」：链内工具条目按 toolCall.id 命中，未知 id 返回 -1。
  test("按条目 id 定位到块下标", () => {
    const entries = [
      ...alternatingMessages(4, "head"),
      toolCall("tool-a"),
      toolCall("tool-b"),
      assistantMessage("answer"),
    ];
    const blocks = buildChatRenderBlocks(entries);

    expect(findBlockIndexByEntryId(blocks, "answer")).toBe(blocks.length - 1);
    expect(findBlockIndexByEntryId(blocks, "tool-b")).toBe(blocks.length - 2);
    expect(findBlockIndexByEntryId(blocks, "missing")).toBe(-1);
  });
});
