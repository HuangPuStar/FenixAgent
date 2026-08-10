import type { AgentNode } from "../types/config";

export type AgentNodeSelection =
  | { kind: "default" }
  | { kind: "sandbox"; sandboxPoolId: string }
  | { kind: "machine"; machineId: string };

export function agentNodeToSelection(node: AgentNode | null | undefined): AgentNodeSelection {
  if (node?.kind === "sandbox") return node;
  if (node?.kind === "machine") return node;
  return { kind: "default" };
}

/** 左侧智能体卡片只标识用户显式接入的远程 Machine。 */
export function shouldShowRemoteNode(node: AgentNode | null | undefined): boolean {
  return node?.kind === "machine";
}

export function selectionToAgentNode(selection: AgentNodeSelection): AgentNode {
  if (selection.kind === "sandbox") return selection;
  if (selection.kind === "machine") return selection;
  return {};
}

export function selectionToValue(selection: AgentNodeSelection): string {
  if (selection.kind === "sandbox") return `sandbox:${selection.sandboxPoolId}`;
  if (selection.kind === "machine") return `machine:${selection.machineId}`;
  return "default";
}

export function valueToSelection(value: string): AgentNodeSelection {
  if (value.startsWith("sandbox:")) return { kind: "sandbox", sandboxPoolId: value.slice("sandbox:".length) };
  if (value.startsWith("machine:")) return { kind: "machine", machineId: value.slice("machine:".length) };
  return { kind: "default" };
}
