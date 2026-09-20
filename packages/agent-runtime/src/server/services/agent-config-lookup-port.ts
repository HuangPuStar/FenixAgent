/**
 * Agent 配置行的读取契约：`agent-runtime` 声明并消费，宿主 `apps/server` 绑定实现。
 *
 * 它与 `agent-launch-spec-port.ts` 的启动端口是一对：启动参数组装走那个，而**启动路径之外**读配置行的
 * 三处（环境绑定校验、实例自动建环境、ACP 的 machine 缓存回填）走本端口。两者都存在的理由是同一份账：
 * `agent-runtime` 对 `@fenix/agent-config` 的依赖是包对级的——只反转启动路径，剩下的调用点仍会把这条边
 * 留在这个包里（阶段 2 任务 1.4 W4b 已消除该边，两个端口自此都只由宿主装配）。
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

/** 取当前生效的配置读取能力；未装配即失败，禁止隐式创建替代实现。 */
export function getAgentConfigLookupPort(): AgentConfigLookupPort {
  if (!boundPort) throw new Error("AgentConfigLookupPort has not been bound");
  return boundPort;
}
