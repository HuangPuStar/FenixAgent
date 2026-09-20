/**
 * 执行节点判定口径的跨包一致性（CE 阶段 2 任务 1.4 W4b 裁定 A）。
 *
 * 背景：`agent_config.agentNode`（JSON 列）优先、回退 `machineId`（历史列）的判定规则原本只有一份
 * （`@fenix/agent-config` 的 `resolveAgentNode`）。W4b 把启动期取数整体移出 agent-runtime 后，
 * 该包不能再依赖资源包（工程规范 §2.3 依赖矩阵），于是在 `orchestration-bootstrap.ts` 内联了一份
 * 等价读取口径。两份文本存在于不同包、由不同人改，是最容易静默分叉的形状：一旦分叉，spawn 选中的
 * 机器与文件路径 / ACP 机器缓存选中的机器会不一致（实例在 A 机器跑、文件操作落到 B 机器）。
 *
 * 本文件用同一组输入同时驱两边，把规则钉死：
 *   - agent-runtime 侧：`createExecutionNodeResolver`（生产 resolver 的工厂，注入 fake prepareSandbox
 *     与显式关闭默认沙盒策略，只保留「显式节点解析」这一半）；
 *   - agent-config 侧：`resolveAgentNode`（规则真相来源）。
 * 断言写成「两侧都等于字面量期望值」而非「两侧互等」：后者在两边被同一人同步改错时依然全绿。
 *
 * 范围边界：`resolveAgentNode` 只管显式节点与列的回退，不含「默认沙盒」「系统默认机器」「local-default」
 * 这条默认链——那条链属于 agent-runtime 的 `EnvironmentRepo`（读模块配置，见
 * `environment-orchestration.ts` 的注释），故本文件显式注入 `sandboxEnabled: false`。
 */

import { describe, expect, test } from "bun:test";
import { resolveAgentNode } from "@fenix/agent-config/server";
import { createExecutionNodeResolver } from "@fenix/agent-runtime/server/testing";

/** agent-config 侧判定 → 两侧可比的规范形（sandbox 加前缀，machine 用裸 id，未指定为 null）。 */
function canonicalFromAgentConfig(input: { agentNode: unknown; machineId: string | null }): string | null {
  const node = resolveAgentNode(input);
  if (node?.kind === "sandbox") return `sandbox:${node.sandboxPoolId}`;
  if (node?.kind === "machine") return node.machineId;
  return null;
}

/** agent-runtime 侧判定 → 同一规范形；sandbox 分支把 poolId 编码进伪造的 nodeId。 */
async function canonicalFromAgentRuntime(agentNode: unknown, configMachineId: string | null): Promise<string | null> {
  const resolver = createExecutionNodeResolver({
    prepareSandbox: async (sandboxPoolId) => `sandbox:${sandboxPoolId}`,
    sandboxEnabled: false,
    defaultSandboxPoolId: null,
  });
  return resolver({
    envId: "env-parity",
    organizationId: "org-1",
    userId: "user-1",
    agentNode,
    configMachineId,
  });
}

describe("执行节点解析口径一致性（agent-runtime ↔ agent-config）", () => {
  // 同一组输入下两侧判定必须一致，且都等于这里的期望值：覆盖显式 sandbox/machine、
  // 空对象（显式清空 → 忽略列）、null/undefined（回退列）、形状非法（回退列）、空串列（视为未绑定）
  test.each([
    ["显式 sandbox 覆盖列", { kind: "sandbox", sandboxPoolId: "pool-1" }, "mach-bound", "sandbox:pool-1"],
    ["显式 sandbox 无列", { kind: "sandbox", sandboxPoolId: "pool-9" }, null, "sandbox:pool-9"],
    ["显式 machine 覆盖列", { kind: "machine", machineId: "mach-A" }, "mach-bound", "mach-A"],
    ["空对象显式清空并忽略列", {}, "mach-bound", null],
    ["空对象且无列", {}, null, null],
    ["空对象且列空串", {}, "", null],
    ["agentNode 为 null 回退列", null, "mach-bound", "mach-bound"],
    ["agentNode 缺省回退列", undefined, "mach-bound", "mach-bound"],
    ["agentNode 为 null 且无列", null, null, null],
    ["列空串视为未绑定", null, "", null],
    ["未知 kind 回退列", { kind: "unknown" }, "mach-bound", "mach-bound"],
    ["machine 缺 machineId 回退列", { kind: "machine" }, "mach-bound", "mach-bound"],
    ["machine 空 machineId 回退列", { kind: "machine", machineId: "" }, "mach-bound", "mach-bound"],
    ["sandbox 空 poolId 回退列", { kind: "sandbox", sandboxPoolId: "" }, "mach-bound", "mach-bound"],
    ["字符串形状非法回退列", "machine:mach-A", "mach-bound", "mach-bound"],
    ["数组形状非法回退列", [{ kind: "machine", machineId: "mach-A" }], "mach-bound", "mach-bound"],
    ["纯量形状非法且无列", 42, null, null],
  ] as Array<
    [string, unknown, string | null, string | null]
  >)("节点判定%s", async (_label, agentNode, machineId, expected) => {
    expect(canonicalFromAgentConfig({ agentNode, machineId })).toBe(expected);
    expect(await canonicalFromAgentRuntime(agentNode, machineId)).toBe(expected);
  });
});
