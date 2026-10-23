import { expect, test } from "bun:test";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { disposeRelayContinuity } from "../runtime/relay-continuity";
import { createRelayLease } from "../runtime/relay-lease";

// 无页面期间 Agent 子进程断开也必须改变连续性，避免把新进程当成已加载的旧会话。
test("Agent continuity observes disconnects between consumer leases", async () => {
  const listeners = new Set<(message: EngineRelayMessage) => void>();
  const physical: EngineRelayHandle = {
    state: "open",
    send() {},
    close() {},
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const first = createRelayLease(physical);
  expect(listeners.size).toBe(0);
  const proof = first.sessionContinuity;
  expect(proof).toBeDefined();
  await first.close();
  for (const listener of [...listeners]) listener({ type: "status", payload: { connected: false } });
  const next = createRelayLease(physical);
  expect(next.sessionContinuity).not.toBe(proof);
  const current = next.sessionContinuity;
  for (const listener of [...listeners]) listener({ type: "status", payload: { connected: true } });
  expect(next.sessionContinuity).toBe(current);
  await next.close();
  disposeRelayContinuity(physical);
  expect(listeners.size).toBe(0);
});
