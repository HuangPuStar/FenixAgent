import { describe, expect, test } from "bun:test";
import { createClaudeCodeRuntime } from "../runtime/claude-code-runtime";

describe("Claude Code runtime relay", () => {
  // relay 应按注册顺序将消息广播给所有监听器，并在取消订阅后停止向该监听器推送。
  test("广播消息并支持取消单个监听器", async () => {
    const relay = await createClaudeCodeRuntime().connectRelay({ instanceId: "instance-1" });
    const receivedByFirst: string[] = [];
    const receivedBySecond: string[] = [];
    const unsubscribeFirst = relay.onMessage?.((message) => receivedByFirst.push(message.type));
    relay.onMessage?.((message) => receivedBySecond.push(message.type));

    relay.send({ type: "first" });
    unsubscribeFirst?.();
    relay.send({ type: "second" });

    expect(relay.state).toBe("open");
    expect(receivedByFirst).toEqual(["first"]);
    expect(receivedBySecond).toEqual(["first", "second"]);
  });

  // 每次连接都应拥有独立监听器集合，避免不同实例的 relay 消息串扰。
  test("隔离不同 relay 的监听器", async () => {
    const runtime = createClaudeCodeRuntime();
    const firstRelay = await runtime.connectRelay({ instanceId: "instance-1" });
    const secondRelay = await runtime.connectRelay({ instanceId: "instance-2" });
    const received: string[] = [];
    firstRelay.onMessage?.((message) => received.push(message.type));

    secondRelay.send({ type: "other-instance" });
    firstRelay.send({ type: "own-instance" });

    expect(received).toEqual(["own-instance"]);
  });
});
