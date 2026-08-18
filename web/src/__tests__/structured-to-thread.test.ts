// web/src/__tests__/structured-to-thread.test.ts
// chatDocEntriesToStructuredMessages 切分回归 + 增量派生（SP-B2 第二步）测试：
// - 切分回归：assistant entry 内文本段被工具调用打断时，展示投影必须切分为多条
//   assistant_message（保持 "ai → tool×N → ai" 的真实顺序，id 唯一）；
//   连续文本流保持单条消息，无文本直接工具调用不产生空消息。
// - 增量派生：per-entry 缓存 + dirty 标记——未变 entry 的派生结果引用稳定
//   （===），重算只重建脏 entry；失效边界（toolCall 状态变更、entry 删除）
//   回落全量重算且结果正确。
//
// 对应后端修复：appendEntryText 顺序感知聚合（打断后新建 text:N 块），
// 前端投影按 tool_call 块切分——两层叠加才能正确渲染。

import { beforeEach, describe, expect, test } from "bun:test";
import type { NormalizedEvent, StructuredMessage } from "@fenix/chat-channel";
// 聚合层服务端能力经 server 子路径导入（双入口边界，见 CLAUDE.md YJS 不变量 11）
import { applyNormalizedEvent, createChatDoc, createSessionDoc, type DocPair } from "@fenix/chat-channel/server";
import * as Y from "yjs";
import { chatDocEntriesToStructuredMessages, structuredToThreadEntries } from "../lib/structured-to-thread";

let pair: DocPair;

function event(type: NormalizedEvent["type"], update: Record<string, unknown> = {}, turnId?: string): NormalizedEvent {
  return { type, update, content: (update.content as Record<string, unknown>) ?? null, turnId };
}

function textOf(m: StructuredMessage): string {
  if (m.type === "assistant_message") return m.chunks.map((c) => c.text).join("");
  return "";
}

beforeEach(() => {
  pair = {
    chat: createChatDoc("rcs_thread", null).ydoc,
    session: createSessionDoc("rcs_thread", null).ydoc,
  };
});

describe("chatDocEntriesToStructuredMessages", () => {
  // 核心回归：ai → tool×10 → ai 必须切分为 三段独立条目
  // （文本段 → 工具组 → 文本段），第二段文本不得与第一段合并显示
  test("splits assistant messages around tool calls preserving order", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "first" } }));
    for (let i = 1; i <= 10; i++) {
      applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: `t${i}`, title: "bash" }));
    }
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "second" } }));

    const messages = chatDocEntriesToStructuredMessages(pair.chat);
    // user + 第一段文本 + 10 工具 + 第二段文本
    expect(messages).toHaveLength(13);

    // 首段沿用 entryId（兼容既有消费者）
    expect(messages[1]).toMatchObject({ type: "assistant_message", id: "turn_1:assistant" });
    expect(textOf(messages[1])).toBe("first");

    // 工具条目按真实顺序插在两段文本之间
    for (let i = 0; i < 10; i++) {
      expect(messages[2 + i].type).toBe("tool_call");
    }

    // 第二段切分为独立消息，id 追加段号保证 React key 唯一
    expect(messages[12]).toMatchObject({ type: "assistant_message", id: "turn_1:assistant#1" });
    expect(textOf(messages[12])).toBe("second");
  });

  // 连续文本流（无工具打断）保持单条消息、单 chunk
  test("continuous text stream stays in a single message", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "a" } }));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "b" } }));

    const messages = chatDocEntriesToStructuredMessages(pair.chat);
    expect(messages).toHaveLength(2);
    const assistant = messages[1];
    // expect 不是类型守卫，显式收窄后再访问 chunks
    if (assistant.type !== "assistant_message") throw new Error("expected assistant message");
    expect(assistant.id).toBe("turn_1:assistant");
    expect(assistant.chunks).toEqual([{ type: "message", text: "ab" }]);
  });

  // 旧 Chat Doc 可能包含同一 turn 的多个计划快照；展示层只保留最后一次更新，
  // 避免历史重放在 ChatView 中渲染多个“执行计划”面板。
  test("keeps only the latest plan snapshot for each turn", () => {
    const entries = structuredToThreadEntries([
      {
        type: "plan",
        id: "plan:turn_1:0",
        entries: [{ content: "inspect files", priority: "medium", status: "in_progress" }],
      },
      {
        type: "plan",
        id: "plan:turn_1:1",
        entries: [{ content: "inspect files", priority: "medium", status: "completed" }],
      },
    ]);

    expect(entries).toEqual([
      {
        type: "plan",
        id: "plan:turn_1:1",
        entries: [{ content: "inspect files", priority: "medium", status: "completed" }],
      },
    ]);
  });

  // 无文本直接工具调用：不得产生空的 assistant_message（切分点仅在文本段之间）
  test("tool call without leading text does not create an empty message", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "late" } }));

    const messages = chatDocEntriesToStructuredMessages(pair.chat);
    // user + tool + 迟到文本段，无空消息
    expect(messages).toHaveLength(3);
    expect(messages[1].type).toBe("tool_call");
    expect(messages[2]).toMatchObject({ type: "assistant_message", id: "turn_1:assistant" });
    expect(textOf(messages[2])).toBe("late");
  });
});

describe("chatDocEntriesToStructuredMessages 增量派生（SP-B2 第二步）", () => {
  // 构造两个完整 turn（user + assistant 文本），返回首次派生结果作为基线
  function seedTwoTurns(): StructuredMessage[] {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q1" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "answer-1" } }));
    applyNormalizedEvent(pair, event("turn_completed", { turnId: "turn_1" }));
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q2" } }, "turn_2"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "answer-2" } }));
    return chatDocEntriesToStructuredMessages(pair.chat);
  }

  // 未变 entry 引用稳定：后一个 turn 追加流式增量只重建该 turn 的 entry，
  // 前序 entry 的消息对象必须保持 ===（ChatView 的 React.memo 依赖此语义）
  test("尾部流式增量只重建脏 entry，未变 entry 引用稳定", () => {
    const before = seedTwoTurns();
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "-more" } }));
    const after = chatDocEntriesToStructuredMessages(pair.chat);

    expect(after).toHaveLength(4);
    // turn_1 的 user / assistant 消息引用稳定
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    // turn_2 的 assistant entry 被重建，内容包含追加文本
    expect(after[3]).not.toBe(before[3]);
    expect(textOf(after[3])).toBe("answer-2-more");
  });

  // toolCall 状态变更定向失效：只有引用该 toolCall 的 entry 重建，
  // 工具消息状态更新为终态，其余 entry 引用稳定。
  // 注：终态 turn 后的 tool 更新会被聚合层拒绝，故在 turn 终态前完成状态迁移
  test("toolCall 状态变更只重建引用 entry", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q1" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "before" } }));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
    const before = chatDocEntriesToStructuredMessages(pair.chat);

    applyNormalizedEvent(pair, event("tool_call_completed", { toolCallId: "t1", title: "bash" }));
    const after = chatDocEntriesToStructuredMessages(pair.chat);

    expect(after).toHaveLength(before.length);
    // user entry（独立 entry）引用稳定；assistant 文本段与工具同 entry，
    // 随 entry 级重派生重建（内容不变，引用可能更新——entry 是失效粒度）
    expect(after[0]).toBe(before[0]);
    expect(textOf(after[1])).toBe(textOf(before[1]));
    // 工具消息重建且状态收敛为 complete
    const tool = after[2];
    if (tool.type !== "tool_call") throw new Error("expected tool_call");
    expect(tool.status).toBe("complete");
    expect(after[2]).not.toBe(before[2]);
  });

  // entry 删除失效边界：物理删除 entry + order 项后输出正确（位移重派生语义）
  test("entry 删除后输出正确收敛", () => {
    const before = seedTwoTurns();
    expect(before).toHaveLength(4);

    pair.chat.transact(() => {
      const root = pair.chat.getMap("root");
      const entries = root.get("entries") as Y.Map<Y.Map<unknown>>;
      const order = root.get("entryOrder") as Y.Array<string>;
      // 删除 turn_1 的 assistant entry（含 order 项）
      entries.delete("turn_1:assistant");
      const idx = order.toArray().indexOf("turn_1:assistant");
      if (idx >= 0) order.delete(idx, 1);
    });
    const after = chatDocEntriesToStructuredMessages(pair.chat);

    // 剩余 turn_1:user + turn_2:user + turn_2:assistant
    expect(after).toHaveLength(3);
    expect(textOf(after[2])).toBe("answer-2");
    // turn_2 的 user entry 位序前移（seq 校正），内容不变
    expect(after[1]).toMatchObject({ type: "user_message", content: "q2" });
  });

  // seq 语义等价：增量路径产出的 seq 与全量重算一致（user=entryOrder 位序、
  // assistant=全局输出序），保证下游依赖 seq 的行为无差异。
  // ts 不参与比对：全量基线在另一时刻复放事件，createdAt 的毫秒值天然不同
  test("增量派生 seq 与全量派生一致", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q1" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "a1" } }));
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q2" } }, "turn_2"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "a2" } }));

    const incremental = chatDocEntriesToStructuredMessages(pair.chat);
    // 用全新 doc 复放同样事件做全量基线（无缓存路径），逐字段比对
    const freshPair: DocPair = {
      chat: createChatDoc("rcs_fresh", null).ydoc,
      session: createSessionDoc("rcs_fresh", null).ydoc,
    };
    for (const evType of [
      event("user_message", { content: { type: "text", text: "q1" } }, "turn_1"),
      event("message_delta", { content: { type: "text", text: "a1" } }),
      event("user_message", { content: { type: "text", text: "q2" } }, "turn_2"),
      event("message_delta", { content: { type: "text", text: "a2" } }),
    ] as NormalizedEvent[]) {
      applyNormalizedEvent(freshPair, evType);
    }
    const fresh = chatDocEntriesToStructuredMessages(freshPair.chat);
    const seqShape = (messages: StructuredMessage[]) =>
      messages.map((m) => ({
        type: m.type,
        id: m.id,
        seq: m.type === "assistant_message" || m.type === "user_message" ? m.seq : undefined,
      }));
    expect(seqShape(incremental)).toEqual(seqShape(fresh));
    // 内容（文本/块）比对：剥离 ts 后应完全一致
    const contentShape = (messages: StructuredMessage[]) =>
      messages.map((m) => {
        if (m.type === "assistant_message") return { type: m.type, id: m.id, chunks: m.chunks, seq: m.seq };
        return { type: m.type, id: m.id };
      });
    expect(contentShape(incremental)).toEqual(contentShape(fresh));
  });

  // 性能验收（SP-B2 第二步）：1000 entries 尾部 append delta 的重算必须显著快于全量重建。
  // 单次 wall-clock 断言对共享 runner 负载抖动敏感（CI 曾 2.27ms > 2ms 误报），
  // 故采用：min-of-5 取最快值剔除 GC/调度单向拖慢；增量 < 全量的相对断言自适应
  // 机器速度；宽松绝对上限（5ms）仅兜底"增量机制退化到接近全量重建"的回归。
  test("1000 entries 尾部增量重算显著快于全量重建", () => {
    for (let i = 1; i <= 1000; i++) {
      applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: `q${i}` } }, `turn_${i}`));
      applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: `a${i}` } }));
    }
    expect(chatDocEntriesToStructuredMessages(pair.chat)).toHaveLength(2000);

    // 增量路径：每次追加尾部 delta 触发"仅脏尾部 entry"重算，取 5 次最快值
    const incTimes: number[] = [];
    for (let i = 1; i <= 5; i++) {
      applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: `-tail-${i}` } }));
      const start = performance.now();
      expect(chatDocEntriesToStructuredMessages(pair.chat)).toHaveLength(2000);
      incTimes.push(performance.now() - start);
    }
    const incMin = Math.min(...incTimes);

    // 全量基线：全新 doc 复放同样事件后冷启动派生（全部 entry 重建，无缓存）
    const freshPair: DocPair = {
      chat: createChatDoc("rcs_full_bench", null).ydoc,
      session: createSessionDoc("rcs_full_bench", null).ydoc,
    };
    for (let i = 1; i <= 1000; i++) {
      applyNormalizedEvent(freshPair, event("user_message", { content: { type: "text", text: `q${i}` } }, `turn_${i}`));
      applyNormalizedEvent(freshPair, event("message_delta", { content: { type: "text", text: `a${i}` } }));
    }
    const fullStart = performance.now();
    expect(chatDocEntriesToStructuredMessages(freshPair.chat)).toHaveLength(2000);
    const fullTime = performance.now() - fullStart;

    // 增量必须显著快于全量（相对断言自适应机器速度）
    expect(incMin).toBeLessThan(fullTime);
    // 宽松绝对上限：即便未来实现整体变快，增量机制退化也不得超过 5ms
    expect(incMin).toBeLessThan(5);
  });

  // turn 失败（ChatEntry.error 脱敏投影）：失败错误必须挂到最后一段助手消息；
  // 整段无文本（纯失败 turn）时也要创建仅含错误的消息，不得出现"空 assistant entry"
  test("turn 失败错误投影到最后一段助手消息", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "partial" } }));
    applyNormalizedEvent(pair, event("turn_failed", { error: { code: "model_error", message: "rate limited" } }));

    const messages = chatDocEntriesToStructuredMessages(pair.chat);
    const assistant = messages[messages.length - 1];
    if (assistant.type !== "assistant_message") throw new Error("expected assistant message");
    expect(assistant.error).toEqual({ code: "model_error", message: "rate limited" });
  });

  // 纯失败 turn（无任何文本输出）也须投影错误消息，前端才能渲染失败态而非空白
  test("纯失败 turn 创建仅含错误的消息", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("turn_failed", { error: { code: "model_error", message: "boom" } }));

    const messages = chatDocEntriesToStructuredMessages(pair.chat);
    expect(messages).toHaveLength(2);
    const assistant = messages[1];
    if (assistant.type !== "assistant_message") throw new Error("expected assistant message");
    expect(assistant.chunks).toEqual([]);
    expect(assistant.error).toEqual({ code: "model_error", message: "boom" });
  });

  // 前一个 turn 已有助手文本，当前 turn 纯失败时错误必须落在本 turn 新建的错误消息，
  // 不得误挂到前一个 turn 的助手消息上（按 entryId 前缀隔离）
  test("纯失败 turn 错误不误挂前一个 turn 的助手消息", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q1" } }, "turn_1"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "prev answer" } }));
    applyNormalizedEvent(pair, event("turn_completed", {}, "turn_1"));

    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q2" } }, "turn_2"));
    applyNormalizedEvent(pair, event("turn_failed", { error: { code: "model_error", message: "boom2" } }));

    const messages = chatDocEntriesToStructuredMessages(pair.chat);
    const errored = messages.filter((m) => m.type === "assistant_message" && m.error);
    expect(errored).toHaveLength(1);
    const err = errored[0];
    if (err.type !== "assistant_message") throw new Error("expected assistant message");
    expect(err.id).toBe("turn_2:assistant#error");
    expect(err.chunks).toEqual([]);
    expect(err.error).toEqual({ code: "model_error", message: "boom2" });
    // 前 turn 助手消息不受污染
    const prev = messages.find((m) => m.type === "assistant_message" && textOf(m) === "prev answer");
    if (!prev || prev.type !== "assistant_message") throw new Error("expected prev assistant message");
    expect(prev.error).toBeUndefined();
  });

  // 工具失败（ToolCallProjection.publicError 脱敏投影）：工具消息必须携带脱敏错误，
  // 供前端 narrate 优先展示（替代 rawOutput 启发式）
  test("工具失败 publicError 投影到工具消息", () => {
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "bash" }));
    applyNormalizedEvent(
      pair,
      event("tool_call_failed", { toolCallId: "t1", error: { code: "exit_1", message: "command failed" } }),
    );

    const messages = chatDocEntriesToStructuredMessages(pair.chat);
    const toolMsg = messages.find((m) => m.type === "tool_call");
    if (!toolMsg || toolMsg.type !== "tool_call") throw new Error("expected tool_call message");
    expect(toolMsg.publicError).toEqual({ code: "exit_1", message: "command failed" });
  });
});
