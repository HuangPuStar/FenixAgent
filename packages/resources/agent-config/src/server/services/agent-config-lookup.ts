import { findAgentConfigNamesByIds } from "../repositories/agent-config";
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

/**
 * 执行节点的**原始**字段（未解析）。
 *
 * 与 {@link AgentConfigLookupResult} 的 `node` 不是一回事：那条已按 `resolveAgentNode` 收敛为权威节点，
 * 而编排域的 machineId fallback 链需要"列值与 agentNode 各自是什么"——它的解析器（`ExecutionNodeResolver`）
 * 自己按 `agentNode` 是否为 null 决定列值是否生效。语义重复会分裂，因此这里原样透传两列，不做归一。
 */
export interface AgentConfigExecutionFields {
  /** `agent_config.machine_id` 列值原样透传（空串表示历史脏数据/显式未绑定，归一由调用方按旧路径 falsy 语义处理）。 */
  readonly machineId: string | null;
  /** `agent_config.agent_node` 原始 JSON；null 与 `{}` 对调用方含义不同，故不在此折叠。 */
  readonly agentNode: unknown;
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
  /** 无授权按资源 ID 读执行节点原始字段（编排域的 machineId fallback 链）。 */
  findAgentConfigExecutionFields(agentConfigId: string): Promise<AgentConfigExecutionFields | null>;
  /**
   * 按 ID **批量**取展示名称；空入参返回空 Map，缺失的 id 不出现在结果里。
   *
   * **无授权判定**（与迁移前 agent-runtime 的 LEFT JOIN 同口径）：调用方只会在已按组织过滤出的
   * environment 行上取它们的 `agentConfigId`，因此这里不额外收窄可见范围，也不引入新的信息面。
   */
  findAgentConfigNamesByIds(ids: readonly string[]): Promise<Map<string, string>>;
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

    async findAgentConfigExecutionFields(agentConfigId) {
      const row = await getAgentConfigById(agentConfigId);
      return row ? { machineId: row.machineId, agentNode: row.agentNode } : null;
    },

    findAgentConfigNamesByIds(ids) {
      return findAgentConfigNamesByIds([...ids]);
    },
  };
}
