import { describe, expect, test } from "bun:test";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createClient, createRelayEvents, createWs } from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";
import { relayOn } from "./relay-event-test-helpers";

describe("RelayEventHandler Peri Task 事件（切片 1）", () => {
  /** 构造合法的 peri/agent_event 帧（subagent_started） */
  const periAgentStarted = (sessionId: string, instanceId = "inst_1") => ({
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: {
      sessionId,
      event_json: JSON.stringify({
        type: "subagent_started",
        value: { instance_id: instanceId, agent_name: "researcher" },
      }),
    },
  });

  // 过期 ACP session 的 Peri 事件必须与 session/update 同规则丢弃：session-bound
  // notification（peri/agent_event / peri/unstable_event）携带的 sessionId 与当前
  // 实例绑定的 ACP session 不一致时直接丢弃，防止旧 session 事件写入当前 rcsSessionId。
  // 观测只记录 method（低基数）+ instanceId，不记录 payload/sessionId（脱敏）。
  test("filters stale peri events against the bound ACP session", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const reports: Array<[string, unknown]> = [];
    const handler = createRelayEvents(registry, broadcaster, processed, {
      reportError: (context, error) => reports.push([context, error]),
    });
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws, acpSessionId: "active-session" }));

    await handler.createMessageHandler(relayOn("rcs-1"))(periAgentStarted("stale-session") as unknown as RelayMessage);

    expect(processed).toEqual([]);
    expect(reports).toEqual([
      ["[YJS-FE] peri task session mismatch", { method: "peri/agent_event", instanceId: "instance-1" }],
    ]);
  });

  // 已协商的 peri/agent_event 始终进入聚合层（normalize → 投影），
  // 与 session/update 共享同一入站管线，不创建第二套连接或 dispatch。
  test("projects peri events into the aggregator", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws, acpSessionId: "ses-1" }));

    await handler.createMessageHandler(relayOn("rcs-1"))(periAgentStarted("ses-1") as unknown as RelayMessage);

    expect(processed).toEqual(["peri_task_started"]);
  });

  // relay replay 窗口内：peri 事件不属于 REPLAY_NEEDS_TURN，不触发回放 turn 合成，
  // 直接投影（background task 无 active turn 也可写入，与消息时间线解耦）。
  test("projects peri events inside the replay window without turn synthesis", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const processed: string[] = [];
    const handler = createRelayEvents(registry, broadcaster, processed);
    const ws = createWs();
    registry.addClient("ws-1", createClient({ ws, acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    // 手动开启回放窗口（真实路径由 session/load 成功响应触发 openReplayWindow）
    shared.replayWindowUntil = Date.now() + 10_000;

    await handler.createMessageHandler(shared)(periAgentStarted("ses-1") as unknown as RelayMessage);

    // 只投递 peri_task_started，不合成 user_message 回放 turn
    expect(processed).toEqual(["peri_task_started"]);
  });
});
