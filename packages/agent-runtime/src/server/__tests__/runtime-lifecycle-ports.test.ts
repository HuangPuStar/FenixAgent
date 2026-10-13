import { afterEach, expect, test } from "bun:test";
import {
  bindEnvironmentAcpLifecyclePort,
  getEnvironmentAcpLifecyclePort,
  resetEnvironmentAcpLifecyclePort,
} from "../../services/environment-core";
import {
  bindAgentInstanceRuntimeOperations,
  getAgentInstanceRuntimeOperations,
  resetAgentInstanceRuntimeOperations,
} from "../services/agent-instance-service";
import {
  bindAcpInstanceActivityPort,
  recordAcpInstanceActivity,
  resetAcpInstanceActivityPort,
} from "../transport/acp-ws-handler";

afterEach(() => {
  resetAcpInstanceActivityPort();
  resetAgentInstanceRuntimeOperations();
  resetEnvironmentAcpLifecyclePort();
});

// 未装配环境生命周期回调时，删除流程读取所需回调必须显式失败。
test("environment lifecycle port fails fast when unbound", async () => {
  resetEnvironmentAcpLifecyclePort();
  try {
    getEnvironmentAcpLifecyclePort();
    expect.unreachable("未绑定端口不应返回生命周期回调");
  } catch (error) {
    expect(error).toHaveProperty("message", "Environment ACP lifecycle port is not bound");
  }
});

// 绑定环境生命周期回调后，删除流程先委托关闭 ACP 连接与停止实例。
test("environment lifecycle port delegates cleanup after binding", async () => {
  const calls: string[] = [];
  const port = {
    closeAcpConnections: (ids: string[]) => calls.push(`close:${ids.join(",")}`),
    stopInstances: async (ids: string[]) => calls.push(`stop:${ids.join(",")}`),
  };
  bindEnvironmentAcpLifecyclePort(port);
  const bound = getEnvironmentAcpLifecyclePort();
  bound.closeAcpConnections(["env_1"]);
  await bound.stopInstances(["env_1"]);
  expect(calls).toEqual(["close:env_1", "stop:env_1"]);
});

// 未装配 ACP 活跃度回调时，传输层不得静默丢弃实例活动。
test("ACP activity port fails fast when unbound", () => {
  resetAcpInstanceActivityPort();
  expect(() => recordAcpInstanceActivity("ins_1", { type: "session_data" })).toThrow(
    "ACP instance activity port is not bound",
  );
});

// 绑定 ACP 活跃度回调后必须透传实例标识与原始消息。
test("ACP activity port delegates after binding", () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  bindAcpInstanceActivityPort((instanceId, message) => calls.push([instanceId, message]));
  recordAcpInstanceActivity("ins_1", { type: "session_data" });
  expect(calls).toEqual([["ins_1", { type: "session_data" }]]);
});

// 未装配实例编排操作时，协调器入口必须明确报告宿主遗漏装配。
test("instance runtime operations fail fast when unbound", () => {
  resetAgentInstanceRuntimeOperations();
  expect(() => getAgentInstanceRuntimeOperations()).toThrow("Agent instance runtime operations are not bound");
});

// 绑定实例编排操作后，公开读取入口返回同一委托实现。
test("instance runtime operations expose the bound delegate", async () => {
  const operations = {
    spawnInstance: async () => undefined,
    stopInstance: async () => undefined,
    hasActiveInstance: () => true,
  };
  bindAgentInstanceRuntimeOperations(operations);
  expect(getAgentInstanceRuntimeOperations()).toBe(operations);
  expect(getAgentInstanceRuntimeOperations().hasActiveInstance("ins_1")).toBe(true);
});
