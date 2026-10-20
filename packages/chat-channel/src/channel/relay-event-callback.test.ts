import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { getEntry } from "../state/chat-writer";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createBoundDocs, createClient, createRelayEvents } from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";
import { relayOn } from "./relay-event-test-helpers";

describe("RelayEventHandler callback routing", () => {
  /** message_delta 走 16ms 微批次合并，断言前等待 flush */
  const waitFlush = () => new Promise((resolve) => setTimeout(resolve, 30));

  /** session/update 帧构造：user_message_chunk（Agent 回显）与 agent_message_chunk（回答增量） */
  const userEchoFrame = (text: string) =>
    ({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } },
    }) as unknown as RelayMessage;
  const agentChunkFrame = (text: string) =>
    ({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "ses-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
    }) as unknown as RelayMessage;

  /** 建立挂 rcs-1 的 relay + 真实 DocManager（共享 relay 与文档一并返回） */
  async function setup() {
    const { docManager, chatDoc, sessionDoc } = await createBoundDocs("rcs-1");
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    return {
      docManager,
      chatDoc,
      sessionDoc,
      handler,
      shared,
      onMessage: handler.createMessageHandler(shared),
    };
  }

  /** 读取 entry 的文本（blockOrder → blocks.text，与投影口径一致） */
  function entryText(chatDoc: Y.Doc, entryId: string): string {
    const entry = getEntry(chatDoc, entryId);
    const blocks = entry?.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
    const order = (entry?.get("blockOrder") as Y.Array<string> | undefined)?.toArray() ?? [];
    return order
      .map((blockId) => {
        const text = blocks?.get(blockId)?.get("text");
        return text instanceof Y.Text ? text.toString() : "";
      })
      .join("");
  }

  /** 按 entryOrder 收集 callback_* 条目 id（缺陷 A 的判定对象） */
  function callbackEntryIds(chatDoc: Y.Doc): string[] {
    const entries = chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    const order = chatDoc.getMap("root").get("entryOrder") as Y.Array<string>;
    return order.toArray().filter((entryId) => entryId.startsWith("callback_") && entries.has(entryId));
  }

  /** 统计指定 role 的 entry 数 */
  function countEntriesByRole(chatDoc: Y.Doc, role: "user" | "assistant"): number {
    const entries = chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.get("role") === role) count++;
    }
    return count;
  }

  // 缺陷 A 回归：用户消息已写入文档（registerUserMessage）后，Agent 的实时回显
  // 不得再建第二条 user 条目，也不得凭空产生 callback 对（修复前会复制出
  // turnId=null 的条目，并把它永久留在 streaming）。
  test("drops the live echo that duplicates an existing user entry", async () => {
    const { docManager, chatDoc, onMessage } = await setup();
    await docManager.registerUserMessage("rcs-1", "第一条消息");

    await onMessage(userEchoFrame("第一条消息"));

    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(callbackEntryIds(chatDoc)).toEqual([]);
  });

  // 回显去重按归一化文本比较：引擎改写空白（换行/多余空格/首尾空白）时仍判为回显，
  // 不得因逐字比较漏判而复制出 callback 条目。
  test("drops the live echo after whitespace normalization", async () => {
    const { docManager, chatDoc, onMessage } = await setup();
    await docManager.registerUserMessage("rcs-1", "第一条 消息");

    await onMessage(userEchoFrame("\n第一条   消息  \n"));

    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(callbackEntryIds(chatDoc)).toEqual([]);
  });

  // 回显被剔除后，本轮回答必须落真实 turn 的 assistant entry（修复前落 callback
  // assistant entry，真实 turn 恒空且 callback 条目永久 streaming）。
  test("routes deltas to the live turn after the echo is dropped", async () => {
    const { docManager, chatDoc, onMessage } = await setup();
    const turnId = await docManager.registerUserMessage("rcs-1", "第一条消息");

    await onMessage(userEchoFrame("第一条消息"));
    await onMessage(agentChunkFrame("回答一"));
    await waitFlush();

    expect(entryText(chatDoc, `${turnId}:assistant`)).toBe("回答一");
    expect(callbackEntryIds(chatDoc)).toEqual([]);
  });

  // b253e3684 隔离意图不回归：文档中不存在同文本 user entry 的无 turnId 消息
  // （真异步回调）仍按原语义建立独立 callback 对，其增量写自己的 assistant entry。
  test("keeps a genuine callback pair when no user entry matches", async () => {
    const { chatDoc, onMessage } = await setup();

    await onMessage(userEchoFrame("后台回调消息"));
    await onMessage(agentChunkFrame("回调回答"));
    await waitFlush();

    const [callbackId, callbackAssistantId] = callbackEntryIds(chatDoc);
    expect(callbackAssistantId).toBe(`${callbackId}:assistant`);
    expect(entryText(chatDoc, callbackAssistantId!)).toBe("回调回答");
  });

  // 核心回归（缺陷 B）：陈旧绑定不得继续吸收新一轮的增量——用户发出新消息后，
  // 无 turnId 的回答增量必须落新 turn 的 assistant entry，旧 callback assistant
  // entry 的文本与状态保持不变（修复前回答被追加进遥远的旧条目且状态永久 streaming）。
  test("stale callback binding does not capture the next turn deltas", async () => {
    const { docManager, chatDoc, onMessage } = await setup();
    await onMessage(userEchoFrame("后台回调消息"));
    await onMessage(agentChunkFrame("回调回答"));
    await waitFlush();
    const callbackAssistantId = callbackEntryIds(chatDoc)[1]!;
    const statusBefore = getEntry(chatDoc, callbackAssistantId)?.get("status");

    const turnId = await docManager.registerUserMessage("rcs-1", "第二条消息");
    await onMessage(agentChunkFrame("回答二"));
    await waitFlush();

    expect(entryText(chatDoc, `${turnId}:assistant`)).toBe("回答二");
    expect(entryText(chatDoc, callbackAssistantId)).toBe("回调回答");
    expect(getEntry(chatDoc, callbackAssistantId)?.get("status")).toBe(statusBefore);
  });

  // 代际不符的回调终态不得回落活动 turn：聚合层会把无 callbackEntryId 的终态
  // 归给当前活动 turn，提前终结用户正在进行的回答（新 turn 增量随后全被丢弃、
  // 答案永不出现）。此类终态直接丢弃，活动 turn 保持可写。
  test("stale callback terminal does not finish the live turn", async () => {
    const { docManager, chatDoc, onMessage } = await setup();
    await onMessage(userEchoFrame("后台回调消息"));
    const turnId = await docManager.registerUserMessage("rcs-1", "第二条消息");

    await onMessage({ type: "prompt_complete", payload: { stopReason: "end_turn" } } as unknown as RelayMessage);
    await onMessage(agentChunkFrame("回答二"));
    await waitFlush();

    expect(entryText(chatDoc, `${turnId}:assistant`)).toBe("回答二");
  });

  // 同会话 load（刷新页面恢复路径）不换代，绑定仍然有效：openReplayWindow 只在
  // 投影真被替换时才能解绑。修复前无条件清空绑定，回调尾部增量全部失去归属，
  // assistant 条目永久停在 streaming（内容静默丢失）。
  test("keeps the callback binding across a same-session replay window", async () => {
    const { chatDoc, handler, shared, onMessage } = await setup();
    await onMessage(userEchoFrame("后台回调消息"));
    const callbackAssistantId = callbackEntryIds(chatDoc)[1]!;
    await onMessage(agentChunkFrame("回调前半"));
    await waitFlush();

    // 刷新页面恢复：prepareLoadSession 早退（未 replaceProjection）后仍会开回放窗口
    handler.openReplayWindow(shared, { resampleSkip: true });
    expect(shared.callbackAssistantEntryId).toBeTruthy();

    await onMessage(agentChunkFrame("回调后半"));
    await waitFlush();

    expect(entryText(chatDoc, callbackAssistantId)).toBe("回调前半回调后半");
  });

  // 换代清理（R3）：load/resume 换代后旧绑定指向的 callback entry 已不在新投影中，
  // 解绑由消费端按 generation 事实完成（不在 openReplayWindow 里抢先清空）——
  // 后续无 turnId 增量按当前活动 turn 归位，不再被聚合层以
  // "callback assistant entry not found" 拒绝而静默丢失。
  test("releases the stale callback binding once the projection generation changes", async () => {
    const { docManager, handler, shared, onMessage } = await setup();
    await onMessage(userEchoFrame("后台回调消息"));
    expect(shared.callbackAssistantEntryId).toBeTruthy();

    await docManager.replaceProjection("rcs-1", "ses-B");
    handler.openReplayWindow(shared, { resampleSkip: true });
    // 换代不清空绑定（同会话 load 场景绑定仍有效），由消费端按事实解绑
    expect(shared.callbackAssistantEntryId).toBeTruthy();

    // 换代后新一轮：无 turnId 增量落新 turn 的 assistant entry（不被失效绑定吃掉）
    const turnId = await docManager.registerUserMessage("rcs-1", "换代后新消息");
    await onMessage(agentChunkFrame("换代后回答"));
    await waitFlush();
    const replacedChatDoc = docManager.getChatYdoc("rcs-1")!;
    expect(entryText(replacedChatDoc, `${turnId}:assistant`)).toBe("换代后回答");
    expect(shared.callbackAssistantEntryId).toBeNull();
    expect(shared.callbackBindingGeneration).toBeNull();
  });

  // 真回调的提问文本可能与上一次回调完全相同（周期性重复触发的任务提示）。
  // 回显去重集合排除 callback_* 条目后，第二次回调仍能建立自己的条目对；
  // 修复前它命中上一次回调写下的条目、整条（提问 + 回答）被静默丢弃。
  test("keeps a repeated callback whose text matches an earlier callback entry", async () => {
    const { chatDoc, onMessage } = await setup();
    await onMessage(userEchoFrame("后台回调消息"));
    await onMessage(agentChunkFrame("第一次回答"));
    await waitFlush();

    await onMessage(userEchoFrame("后台回调消息"));
    await onMessage(agentChunkFrame("第二次回答"));
    await waitFlush();

    const ids = callbackEntryIds(chatDoc);
    expect(ids).toHaveLength(4);
    expect(entryText(chatDoc, ids[1]!)).toBe("第一次回答");
    expect(entryText(chatDoc, ids[3]!)).toBe("第二次回答");
  });
});
