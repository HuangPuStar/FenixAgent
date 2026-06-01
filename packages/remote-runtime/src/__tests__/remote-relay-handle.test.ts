import { expect, test } from "bun:test";
import { RemoteRelayHandle } from "../remote-relay-handle";
import { createMockTransport, type MockTransport } from "./fixtures/mock-transport";

function createHandleAndTransport(): { handle: RemoteRelayHandle; transport: MockTransport } {
  const transport = createMockTransport();
  const handle = new RemoteRelayHandle(transport, "inst_1", "sess_1");
  return { handle, transport };
}

// relay handle 初始状态为 open
test("RemoteRelayHandle: initial state is open", () => {
  const { handle } = createHandleAndTransport();
  expect(handle.state).toBe("open");
});

// send 通过 transport 发送 relay 消息
test("RemoteRelayHandle: send forwards relay message via transport", () => {
  const { handle, transport } = createHandleAndTransport();
  handle.send({ type: "prompt", payload: { content: "hello" } });
  expect(transport.sentMessages).toContainEqual(
    expect.objectContaining({
      type: "relay",
      instance_id: "inst_1",
      session_id: "sess_1",
      payload: { type: "prompt", payload: { content: "hello" } },
    }),
  );
});

// close 后 send 抛错
test("RemoteRelayHandle: send throws after close", () => {
  const { handle } = createHandleAndTransport();
  handle.close();
  expect(() => handle.send({ type: "test" })).toThrow("closed");
});

// close 发送 relay_close 并变为 closed
test("RemoteRelayHandle: close sends relay_close message", () => {
  const { handle, transport } = createHandleAndTransport();
  handle.close();
  expect(handle.state).toBe("closed");
  expect(transport.sentMessages).toContainEqual(
    expect.objectContaining({ type: "relay_close", instance_id: "inst_1" }),
  );
});

// onMessage 接收 session 消息（payload 内嵌真正的 ACP 消息）
test("RemoteRelayHandle: onMessage receives session messages from transport", () => {
  const { handle, transport } = createHandleAndTransport();
  const received: Array<{ type: string; payload?: unknown }> = [];
  handle.onMessage((msg) => received.push(msg));

  transport.simulateSessionMessage("inst_1", "sess_1", {
    type: "relay",
    instance_id: "inst_1",
    session_id: "sess_1",
    payload: { type: "session_update", payload: { text: "hi" } },
  });
  expect(received).toEqual([{ type: "session_update", payload: { text: "hi" } }]);
});

// onMessage 过滤不匹配的 instance/session
test("RemoteRelayHandle: onMessage ignores messages for other instances", () => {
  const { handle, transport } = createHandleAndTransport();
  const received: unknown[] = [];
  handle.onMessage((msg) => received.push(msg));

  transport.simulateSessionMessage("inst_other", "sess_1", { type: "session_update" });
  expect(received).toHaveLength(0);
});
