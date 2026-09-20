import type { AgentConfigRow, ScopedAgentConfigRow } from "../repositories/agent-config-resource";
import { getAgentConfigById, getAgentConfigVisibleToUser } from "../system-entries";
import { resolveAgentNode } from "./config/agent-config";

/**
 * Agent 配置的**查询投影**：把「资源行」收窄成 agent-runtime 消费的那几个字段，并把执行节点的
 * 判定在这里做完。
 *
 * 为什么要投影而不是直接给行：消费方（`AgentConfigLookupPort`）只需要"叫什么、跑在哪"，给它完整
 * 资源行就会诱使它自己判归属、自己解析 `agentNode`/`machineId` 的优先级。节点解析规则只此一份
 * （{@link resolveAgentNode}），`agentNode` 优先、回退 `machineId`、空值归一为 `null`。
 *
 * 本文件不含授权实现：两个入口分别复用 `system-entries` 的"无授权读"与"按真实用户身份的可见读"。
 */

/** 执行节点：与 agent-runtime 侧端口同形（结构化对齐，不在包间共享类型）。 */
export type AgentConfigExecutionNode =
  | { readonly kind: "machine"; readonly machineId: string }
  | { readonly kind: "sandbox"; readonly sandboxPoolId: string };

export interface AgentConfigLookupResult {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly node: AgentConfigExecutionNode | null;
}

/** 查询投影的读入口；宿主把它绑定到 agent-runtime 的 `AgentConfigLookupPort`。 */
export interface AgentConfigLookup {
  /** 无授权按资源 ID 读。 */
  findAgentConfig(agentConfigId: string): Promise<AgentConfigLookupResult | null>;
  /** 按真实用户身份的组织可见性读。 */
  findVisibleAgentConfig(input: {
    agentConfigId: string;
    organizationId: string;
    userId: string;
  }): Promise<AgentConfigLookupResult | null>;
}

/** 行 → 投影；`node` 为 `{}`（显式清空且无 `machineId`）时归一为 `null`。 */
function toLookupResult(row: AgentConfigRow | ScopedAgentConfigRow): AgentConfigLookupResult {
  const node = resolveAgentNode(row);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    node:
      node?.kind === "machine"
        ? { kind: "machine", machineId: node.machineId }
        : node?.kind === "sandbox"
          ? { kind: "sandbox", sandboxPoolId: node.sandboxPoolId }
          : null,
  };
}

/** 构造查询投影；宿主启动装配阶段构造一次后绑定（无状态，重复构造等价）。 */
export function createAgentConfigLookup(): AgentConfigLookup {
  return {
    async findAgentConfig(agentConfigId) {
      const row = await getAgentConfigById(agentConfigId);
      return row ? toLookupResult(row) : null;
    },

    async findVisibleAgentConfig(input) {
      const row = await getAgentConfigVisibleToUser(input);
      return row ? toLookupResult(row) : null;
    },
  };
}
