import { afterEach, expect, test } from "bun:test";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { createAgentSession, startPromptTurn } from "../services/agent-chat-service";
import { acquireAgentSessionTurn, releaseAgentSessionTurns } from "../services/agent-session-admission";

const instanceId = "session-admission-regression";
afterEach(() => releaseAgentSessionTurns(instanceId));
function transport() {
  const listeners = new Set<(message: EngineRelayMessage) => void>();
  const requests: Array<Record<string, unknown>> = [];
  const handle: EngineRelayHandle = {
    state: "open",
    close() {},
    send(message) {
      requests.push(message as unknown as Record<string, unknown>);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    session: createAgentSession({ instanceId, relayHandle: handle }),
    requests,
    emit(message: unknown) {
      for (const listener of listeners) listener(message as EngineRelayMessage);
    },
  };
}

// 相同显式 session 的第二次握手必须在发送 load 前拒绝，避免取消影响其他请求。
test("same explicit ACP session rejects concurrent handshake before any competing RPC", async () => {
  const relay = transport();
  const pending = startPromptTurn({ session: relay.session, sessionId: "ses-shared" });
  await expect(startPromptTurn({ session: relay.session, sessionId: "ses-shared" })).rejects.toMatchObject({
    statusCode: 409,
  });
  expect(relay.requests).toHaveLength(1);
  relay.emit({ jsonrpc: "2.0", id: relay.requests[0].id, result: {} });
  const { turn } = await pending;
  turn.prompt([{ type: "text", text: "first" }]);
  await turn.cancel();
  await expect(startPromptTurn({ session: relay.session, sessionId: "ses-shared" })).rejects.toMatchObject({
    statusCode: 409,
  });
  expect(relay.requests.map((rpc) => rpc.method)).toEqual(["session/load", "session/prompt", "session/cancel"]);
  relay.emit({ jsonrpc: "2.0", id: relay.requests[1].id, result: { stopReason: "cancelled" } });
  const next = startPromptTurn({ session: relay.session, sessionId: "ses-shared" });
  relay.emit({ jsonrpc: "2.0", id: relay.requests[3].id, result: {} });
  await (await next).turn.dispose();
});

// 未确认的 load 取消不能立即解锁，只有运行实体已确认停止才允许新的会话所有者。
test("cancelled unacknowledged load remains exclusive until confirmed runtime stop", async () => {
  const relay = transport();
  const controller = new AbortController();
  const pending = startPromptTurn({ session: relay.session, sessionId: "ses-loading", signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(() => acquireAgentSessionTurn(instanceId, "ses-loading")).toThrow("active turn");
  releaseAgentSessionTurns(instanceId);
  acquireAgentSessionTurn(instanceId, "ses-loading").release();
});

// 旧代租约迟到释放不能删除 runtime 重启后新代建立的排他所有权。
test("old lease release cannot delete the replacement session owner", () => {
  const old = acquireAgentSessionTurn(instanceId, "ses-restarted");
  releaseAgentSessionTurns(instanceId);
  const replacement = acquireAgentSessionTurn(instanceId, "ses-restarted");
  old.release();
  expect(() => acquireAgentSessionTurn(instanceId, "ses-restarted")).toThrow("active turn");
  replacement.release();
  acquireAgentSessionTurn(instanceId, "ses-restarted").release();
});
