/**
 * Agent 配置取数端口的宿主实现（`@fenix/resource-machine` 的 `MachineAgentConfigPort`）。
 *
 * machine 声明了窄端口（执行节点读取 / 机器引用检查），但不依赖 `agent-config`：那正是 §2.3
 * 矩阵外的反向边 `machine → agent-config`——它与 agent-config → agent-runtime、agent-runtime → sandbox、
 * sandbox → machine 共同闭合 4 包环族。本文件把端口接到 owner 的公开入口上，方向固定为
 * `apps/server → agent-config`（宿主可以依赖任何包的公开入口）。
 *
 * 两个原语都不是"直读对方的表"，而是各自领域规则的复用：
 *   - `getExecutionNode`：`agentNode` 优先、回退 `machineId` 列的解析规则只在 agent-config 一份；
 *   - `isAgentConfigBoundToMachine`：`machine_id` 列的归属条件与存在性判定归对方；
 *
 * 归属：`getExecutionNode` 按 ID 无归属读（`getAgentConfigById(id)`），并把配置的 `organizationId` 随节点
 * 一起返回。这不绕过授权——显式执行节点是 Agent 配置的依赖，跨组织共享时调用方用的就是同一节点；环境属主
 * 与绑定时的可见性校验发生在更上游。返回组织是必需的：显式沙盒池要按池所属组织解析，而池属于配置的组织。
 *
 * 为什么归在 `apps/server/src/services/`：与 `model-gateway-subject-verification.ts` 同一分工——它是宿主对
 * 资源包端口的适配，不是任何一方的领域逻辑；放在服务层让"谁实现端口"在目录上直接可查。
 */

import { getAgentConfigById, isAgentConfigBoundToMachine, resolveAgentNode } from "@fenix/agent-config/server";
import type { MachineAgentConfigNode, MachineAgentConfigPort } from "@fenix/resource-machine/server";

export const machineAgentConfigPort: MachineAgentConfigPort = {
  async getExecutionNode({ agentConfigId }): Promise<MachineAgentConfigNode | null> {
    const row = await getAgentConfigById(agentConfigId);
    if (!row) return null;
    // `resolveAgentNode` 的第三种返回值是空节点（`{}`，显式清空且无 `machineId` 列值），对 machine 与
    // `null` 同义——两者都表示「这个环境没有声明执行节点」，因此在这里归一，不让空对象穿到调用方。
    const node = resolveAgentNode(row);
    if (!node) return null;
    if (node.kind === "machine") {
      return { kind: "machine", machineId: node.machineId, organizationId: row.organizationId };
    }
    if (node.kind === "sandbox") {
      return { kind: "sandbox", sandboxPoolId: node.sandboxPoolId, organizationId: row.organizationId };
    }
    return null;
  },
  isAgentConfigBoundToMachine,
};
