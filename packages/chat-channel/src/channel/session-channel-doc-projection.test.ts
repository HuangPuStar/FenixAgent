import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { getAgentStatus, getChatRoot, getSessionRoot } from "../state/chat-writer";
import { createConnection, createHarness, createSinks, readEntryIds } from "./session-channel-action-test-helpers";

describe("SessionChannel doc projection", () => {
  // 断线后同 commandId 保留去重，不重复投影用户消息。
  test("disposeRcsSession retains dedup state so resubmission does not execute", async () => {
    const harness = createHarness();
    const { connection, relayMessages } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");

    await harness.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "first" }] },
      createSinks(harness),
    );
    expect(relayMessages).toHaveLength(1);

    harness.channel.disposeRcsSession("rcs-1");
    await harness.channel.handleAction(
      connection,
      { action: "send_prompt", commandId: "cmd-1", content: [{ type: "text", text: "again" }] },
      createSinks(harness),
    );

    expect(relayMessages).toHaveLength(1);
    // 重连重发不产生第二个 turn。
    expect(readEntryIds(harness.docManager.getChatYdoc("rcs-1") as Y.Doc)).toHaveLength(2);
  });

  // agent status 消息经规范化事件投影到 Session Doc（agent.status ready）。
  test("agent status is projected to session doc via normalized event", async () => {
    const harness = createHarness();
    const { connection } = createConnection();
    await harness.docManager.openChat("rcs-1");
    await harness.docManager.openSession("user-1", "agent-1", "rcs-1");

    harness.docManager.processNormalizedEvent("rcs-1", {
      type: "agent_status",
      update: { instanceId: "instance-1", status: "ready", capabilities: { loadSession: true } },
      content: null,
    });

    const sessionDoc = harness.docManager.getSessionYdoc("rcs-1");
    expect(getAgentStatus(sessionDoc as Y.Doc).get("status")).toBe("ready");
    // projectionVersion 按触达 bump（SP-A2）：agent_status 只写 Session Doc，
    // Session Doc 版本递增，Chat Doc 未被触碰版本不动
    expect(getSessionRoot(sessionDoc as Y.Doc).get("projectionVersion")).toBeGreaterThan(1);
    expect(getChatRoot(harness.docManager.getChatYdoc("rcs-1") as Y.Doc).get("projectionVersion")).toBe(1);
    void connection;
  });
});
