import { describe, expect, test } from "bun:test";
import {
  AGENT_SETTABLE_FIELDS,
  normalizeAgentNode,
  resolveAgentNode,
  validateAgentData,
} from "../services/config/agent-config";

describe("AgentNode 配置", () => {
  // sandbox 节点应保留资源池选择，而不是被当作 machine 配置。
  test("规范化 sandbox 节点并从配置行解析", () => {
    const node = { kind: "sandbox", sandboxPoolId: "default" } as const;
    expect(normalizeAgentNode(node)).toEqual(node);
    expect(resolveAgentNode({ agentNode: node, machineId: null })).toEqual(node);
  });

  // 历史空 agentNode 且没有旧 machineId 时，应进入动态默认节点解析。
  test("将历史空配置解析为默认节点", () => {
    expect(resolveAgentNode({ agentNode: null, machineId: null })).toEqual({});
  });

  // 历史 agentNode 为空但 machineId 有值时，继续兼容旧的显式机器配置。
  test("兼容 agentNode 为空时的旧 machineId", () => {
    expect(resolveAgentNode({ agentNode: null, machineId: "machine-1" })).toEqual({
      kind: "machine",
      machineId: "machine-1",
    });
  });

  // 新配置显式保存空对象后，不能再被旧 machineId 覆盖。
  test("显式空对象优先于旧 machineId", () => {
    expect(resolveAgentNode({ agentNode: {}, machineId: "machine-1" })).toEqual({});
  });

  // 兼容迁移期间的旧 machineId；存在 agentNode 时始终以 agentNode 为准。
  test("sandbox 节点存在时忽略同时存在的 machineId", () => {
    expect(
      validateAgentData({
        agentNode: { kind: "sandbox", sandboxPoolId: "default" },
        machineId: "machine-1",
      }),
    ).toBeNull();
  });

  // agentNode 必须进入统一的可写字段白名单。
  test("agentNode 是可写配置字段", () => {
    expect(AGENT_SETTABLE_FIELDS).toContain("agentNode");
  });
});
