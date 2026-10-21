import { describe, expect, test } from "bun:test";
import type { NormalizedEvent } from "../schema";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createBoundDocs, createClient, createRelayEvents } from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";
import { relayOn } from "./relay-event-test-helpers";

describe("RelayEventHandler sync turn binding", () => {
  /** session/update 帧构造：agent_message_chunk → message_delta */
  const agentChunkFrame = (text: string, params: Record<string, unknown> = {}) =>
    ({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        ...params,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      },
    }) as unknown as RelayMessage;

  /** 真实 DocManager + 捕获 onNormalizedEvent 的装配（活动 turn 由测试自行建立） */
  async function setup() {
    const { docManager } = await createBoundDocs("rcs-1");
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const forwarded: NormalizedEvent[] = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      docManager,
      onNormalizedEvent: (_rcsSessionId, event) => forwarded.push(event),
    });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    return { docManager, forwarded, onMessage: handler.createMessageHandler(relayOn("rcs-1")) };
  }

  // 子 Agent 增量没有 turnId 时保持无归属，不得绑定主 Agent 的活动 turn。
  test("subagent delta without turnId is not bound to the active turn", async () => {
    const { docManager, forwarded, onMessage } = await setup();
    const activeTurnId = await docManager.registerUserMessage("rcs-1", "主消息");

    await onMessage(agentChunkFrame("子 Agent 输出", { _meta: { peri: { sourceAgentId: "child_1" } } }));

    const delta = forwarded.find((event) => event.type === "message_delta");
    expect(activeTurnId).toBeTruthy();
    expect(delta?.sourceAgentId).toBe("child_1");
    expect(delta?.turnId ?? null).toBeNull();
  });

  // callback 增量已由 callbackEntryId 归属，不得再借用主 Agent 的活动 turn。
  test("callback delta without turnId is not bound to the active turn", async () => {
    const { docManager, forwarded, onMessage } = await setup();
    await docManager.registerUserMessage("rcs-1", "主消息");

    await onMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "后台回调消息" } },
      },
    } as unknown as RelayMessage);
    await onMessage(agentChunkFrame("回调回答"));

    const delta = forwarded.find((event) => event.type === "message_delta");
    expect(delta?.callbackEntryId).toBeTruthy();
    expect(delta?.turnId ?? null).toBeNull();
  });

  // 防回归：主 Agent 普通无 turnId 增量仍按活动 turn 绑定。
  test("main-agent delta without turnId still binds the active turn", async () => {
    const { docManager, forwarded, onMessage } = await setup();
    const activeTurnId = await docManager.registerUserMessage("rcs-1", "主消息");

    await onMessage(agentChunkFrame("主 Agent 回答"));

    const delta = forwarded.find((event) => event.type === "message_delta");
    expect(delta?.turnId).toBe(activeTurnId);
  });
});
