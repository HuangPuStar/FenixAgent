import { afterEach, expect, test } from "bun:test";
import {
  bindRelayLifecyclePort,
  closeRelayConnectionsForIdleReclaim,
  closeRelayConnectionsForStoppedInstance,
  resetRelayLifecyclePort,
} from "./lifecycle-port";

afterEach(() => resetRelayLifecyclePort());

// 未装配时必须显式失败，避免实例回收静默遗漏实时连接清理。
test("relay lifecycle port rejects an unbound cleanup operation", () => {
  resetRelayLifecyclePort();
  expect(() => closeRelayConnectionsForIdleReclaim("ins_1")).toThrow("Relay lifecycle port is not bound");
});

// 装配后 idle 回收必须携带既有关闭码和原因转发给 Chat 生命周期实现。
test("relay lifecycle port forwards idle cleanup after binding", () => {
  const calls: Array<[string, number, string]> = [];
  bindRelayLifecyclePort({
    closeClientsByInstance: (instanceId, code, reason) => calls.push([instanceId, code, reason]),
    reclaimInstanceRealtimeResources: async () => undefined,
    closeAllClients: () => undefined,
  });

  closeRelayConnectionsForIdleReclaim("ins_1");

  expect(calls).toEqual([["ins_1", 4001, "instance_idle_reclaimed"]]);
});

// 停止实例的关闭码必须与客户端策略表同源（acp-link 的 4002）：两端各自写字面量会让
// 「用户主动停止」在客户端退化成一次无效重连 + 「Agent 实例启动失败」错误卡。
test("relay lifecycle port forwards manual stop with the shared close code", () => {
  const calls: Array<[string, number, string]> = [];
  bindRelayLifecyclePort({
    closeClientsByInstance: (instanceId, code, reason) => calls.push([instanceId, code, reason]),
    reclaimInstanceRealtimeResources: async () => undefined,
    closeAllClients: () => undefined,
  });

  closeRelayConnectionsForStoppedInstance("ins_1");

  expect(calls).toEqual([["ins_1", 4002, "instance_stopped"]]);
});
