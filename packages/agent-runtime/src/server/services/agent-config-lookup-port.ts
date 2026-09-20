import { getAgentConfigById, getReadableAgentConfigById, resolveAgentNode } from "@fenix/agent-config/server";
import { toActorContext } from "../../services/actor-context";

/**
 * Agent 配置行的读取契约：`agent-runtime` 声明并消费，宿主 `apps/server` 绑定实现。
 *
 * 它与 `agent-launch-spec-port.ts` 的启动端口是一对：启动参数组装走那个，而**启动路径之外**读配置行的
 * 三处（环境绑定校验、实例自动建环境、ACP 的 machine 缓存回填）走本端口。两者都存在的理由是
 * 同一份账：`agent-runtime` 对 `@fenix/agent-config` 的依赖必须整体消除，而依赖指纹是包对级——
 * 只反转启动路径，剩下的调用点仍会把这条边留在这个包里。
 */

/** 执行节点：agent 配置的 `agentNode` 与扁平 `machineId` 列已在实现侧收敛为一处判定。 */
export type AgentExecutionNode =
  | { readonly kind: "machine"; readonly machineId: string }
  | { readonly kind: "sandbox"; readonly sandboxPoolId: string };

/**
 * 已解析的配置投影。
 *
 * 刻意不是资源行：不含归属列、不含授权模型、也不含 `access` 元数据。调用方要的是"这个 Agent 叫什么、
 * 跑在哪"，多给字段只会诱使调用方自己判权限。
 */
export interface AgentConfigLookupResult {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** 未绑定任何执行节点时为 null（空 `agentNode` 且无 `machineId`）。 */
  readonly node: AgentExecutionNode | null;
}

export interface AgentConfigLookupPort {
  /** 无授权按资源 ID 读（transport 层的机器解析）。 */
  findAgentConfig(agentConfigId: string): Promise<AgentConfigLookupResult | null>;
  /** 按真实用户身份的组织可见性读（环境绑定校验、实例自动创建）。 */
  findVisibleAgentConfig(input: {
    agentConfigId: string;
    organizationId: string;
    userId: string;
  }): Promise<AgentConfigLookupResult | null>;
}

let boundPort: AgentConfigLookupPort | null = null;

/** 由 `apps/server` 绑定唯一实现（委托 agent-config 的包根入口）。 */
export function bindAgentConfigLookupPort(port: AgentConfigLookupPort): void {
  if (boundPort && boundPort !== port) throw new Error("AgentConfigLookupPort has already been bound");
  boundPort = port;
}

/** 测试用：清空宿主绑定，防止测试进程内状态泄漏。 */
export function resetAgentConfigLookupPort(): void {
  boundPort = null;
}

/**
 * 取当前生效的配置读取能力。
 *
 * W4a 过渡期语义与 {@link getAgentLaunchSpecPort} 一致：宿主未绑定时回退到包内旧读取（直接调
 * agent-config 的入口 + 伪造 owner 主体），W4b 随旧依赖一并删除，届时未装配即 fail-fast。
 */
export function getAgentConfigLookupPort(): AgentConfigLookupPort {
  return boundPort ?? legacyAgentConfigLookupPort;
}

/** 行（无授权读 / 可见读两种行形状）→ 投影；节点判定交给 agent-config 的 `resolveAgentNode`。 */
function toLookupResult(row: {
  id: string;
  name: string;
  description: string | null;
  agentNode?: unknown;
  machineId: string | null;
}): AgentConfigLookupResult {
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

/** W4a 过渡期默认实现（W4b 随旧路径删除）。 */
const legacyAgentConfigLookupPort: AgentConfigLookupPort = {
  async findAgentConfig(agentConfigId) {
    const row = await getAgentConfigById(agentConfigId);
    return row ? toLookupResult(row) : null;
  },

  async findVisibleAgentConfig(input) {
    const row = await getReadableAgentConfigById(
      toActorContext({ organizationId: input.organizationId, userId: input.userId, role: "owner" }),
      input.agentConfigId,
    );
    return row ? toLookupResult(row) : null;
  },
};
