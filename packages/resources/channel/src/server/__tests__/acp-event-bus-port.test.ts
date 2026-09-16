import { afterEach, expect, test } from "bun:test";
import { bindAcpEventBusPort, getAcpEventBusPort, resetAcpEventBusPort } from "../services/acp-event-bus-port";

afterEach(() => resetAcpEventBusPort());

// Hermes 只经宿主绑定的 ACP 事件总线订阅 Agent 回复，不能反向依赖 Machine 包。
test("channel ACP event-bus port 返回绑定的订阅总线", () => {
  const bus = { subscribe: () => () => {} };
  bindAcpEventBusPort({ getAcpBus: () => bus });

  expect(getAcpEventBusPort().getAcpBus("agent_1")).toBe(bus);
});
