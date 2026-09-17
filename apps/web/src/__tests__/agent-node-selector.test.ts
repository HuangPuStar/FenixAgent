import { describe, expect, test } from "bun:test";
import {
  agentNodeToSelection,
  selectionToAgentNode,
  selectionToValue,
  shouldShowRemoteNode,
  valueToSelection,
} from "../lib/agent-node";

describe("运行节点选择", () => {
  // 本地默认节点保存为空对象，交给后端运行时动态解析。
  test("本地默认转换为空 Agent Node", () => {
    const selection = { kind: "default" } as const;
    expect(selectionToAgentNode(selection)).toEqual({});
    expect(valueToSelection(selectionToValue(selection))).toEqual(selection);
  });

  // 左侧卡片只为用户自接入的 Machine 显示“远程”标识。
  test("仅普通 Machine 显示远程节点标识", () => {
    expect(shouldShowRemoteNode({ kind: "machine", machineId: "mach-1" })).toBe(true);
    expect(shouldShowRemoteNode({ kind: "sandbox", sandboxPoolId: "default" })).toBe(false);
    expect(shouldShowRemoteNode({})).toBe(false);
  });

  // Sandbox Pool 选择必须保存资源池 ID，而不是底层 Machine ID。
  test("Sandbox Pool 选择转换为 sandbox Agent Node", () => {
    const selection = { kind: "sandbox", sandboxPoolId: "default" } as const;
    expect(selectionToAgentNode(selection)).toEqual({ kind: "sandbox", sandboxPoolId: "default" });
    expect(valueToSelection(selectionToValue(selection))).toEqual(selection);
  });

  // Machine 选择必须保存显式 Machine ID。
  test("Machine 选择转换为 machine Agent Node", () => {
    const selection = { kind: "machine", machineId: "mach-1" } as const;
    expect(agentNodeToSelection({ kind: "machine", machineId: "mach-1" })).toEqual(selection);
    expect(valueToSelection(selectionToValue(selection))).toEqual(selection);
  });
});
