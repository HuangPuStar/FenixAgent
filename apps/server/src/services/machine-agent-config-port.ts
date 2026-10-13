/**
 * Agent 配置取数端口的宿主实现（`@fenix/resource-machine` 的 `MachineAgentConfigPort`）。
 *
 * machine 声明了窄端口（执行节点读取 / 机器引用检查 / 注册绑定），但不依赖 `agent-config`：那正是 §2.3
 * 矩阵外的反向边 `machine → agent-config`——它与 agent-config → agent-runtime、agent-runtime → sandbox、
 * sandbox → machine 共同闭合 4 包环族。本文件把端口接到 owner 的公开入口上，方向固定为
 * `apps/server → agent-config`（宿主可以依赖任何包的公开入口）。
 *
 * 三个原语都不是"直读对方的表"，而是各自领域规则的复用：
 *   - `getExecutionNode`：`agentNode` 优先、回退 `machineId` 列的解析规则只在 agent-config 一份；
 *   - `isAgentConfigBoundToMachine`：`machine_id` 列的归属条件与存在性判定归对方；
 *   - `bindMachineIdByAgentName`：按名称匹配本组织配置、同名多条一起绑定归对方（§4.8 第 7 条的写入口）。
 *
 * 归属校验（E2）：`getExecutionNode` 把组织上下文透传给 `getAgentConfigById(id, organizationId)`——该入口
 * 在 owner 侧同时按 `organization_id` 收窄，跨组织的配置读成 `null`。宿主这一层**不得**改成"先无归属读、
 * 再自己比较 organizationId"：那会把归属谓词复制到装配层，与本仓库"授权/归属规则只有一份"的口径相悖。
 *
 * 为什么归在 `apps/server/src/services/`：与 `model-gateway-subject-verification.ts` 同一分工——它是宿主对
 * 资源包端口的适配，不是任何一方的领域逻辑；放在服务层让"谁实现端口"在目录上直接可查。
 */

import {
  bindMachineIdByAgentName,
  getAgentConfigById,
  isAgentConfigBoundToMachine,
  resolveAgentNode,
} from "@fenix/agent-config/server";
import type { MachineAgentConfigNode, MachineAgentConfigPort } from "@fenix/resource-machine/server";

export const machineAgentConfigPort: MachineAgentConfigPort = {
  async getExecutionNode({ agentConfigId, organizationId }): Promise<MachineAgentConfigNode | null> {
    const row = await getAgentConfigById(agentConfigId, organizationId);
    if (!row) return null;
    // `resolveAgentNode` 的第三种返回值是空节点（`{}`，显式清空且无 `machineId` 列值），对 machine 与
    // `null` 同义——两者都表示「这个环境没有声明执行节点」，因此在这里归一，不让空对象穿到调用方。
    const node = resolveAgentNode(row);
    if (!node) return null;
    if (node.kind === "machine") return { kind: "machine", machineId: node.machineId };
    if (node.kind === "sandbox") return { kind: "sandbox", sandboxPoolId: node.sandboxPoolId };
    return null;
  },
  isAgentConfigBoundToMachine,
  bindMachineIdByAgentName,
};
