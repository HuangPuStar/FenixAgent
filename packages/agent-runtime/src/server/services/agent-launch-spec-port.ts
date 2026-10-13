import type { AgentLaunchSpec } from "@fenix/plugin-sdk";

/**
 * 启动参数组装的能力契约：`agent-runtime` 声明并消费，宿主 `apps/server` 绑定实现。
 *
 * 为什么是端口而不是直接调用：`AgentLaunchSpec` 的组装要从 Agent 配置向外解析模型、Skill、MCP、
 * 知识库与记忆——这些能力属于各资源包的领域，`agent-runtime` 只该负责「实例起来之后怎么管」。端口把
 * 「取数」推给宿主装配的 agent-config 组装器，本包因此不再依赖任何资源领域包（review §15.3）。
 *
 * 方向是 pull（本包取数、宿主绑定），不是 push（Facade 反向调启动）：push 版必须改启动入口签名，
 * 而那些签名在冻结文件 `agent-instance-service.ts` 里（§2.1 红线）。
 */

/**
 * 一次启动所需的启动参数请求。
 *
 * 不含 `ActorContext`：主体由组装方按 `ownerUserId` + 组织经身份目录还原（§9.1 的真实用户身份），
 * 调用方没有伪造 `role` 的机会。
 */
export interface AgentLaunchSpecRequest {
  /** 环境 ID：随 spec 下发，core 侧按它定位实例上下文。 */
  environmentId: string;
  readonly organizationId: string;
  /** 实例属主；同时是网关凭证与 Hindsight bank 的主体。 */
  readonly ownerUserId: string;
  /** 环境行绑定的 Agent 配置 ID。 */
  readonly agentConfigId: string;
  /**
   * 环境密钥：仅用于知识库 MCP 项的 `Authorization` header。
   *
   * 只有组装方知道该 header 的形状，故密钥必须随请求传入；边界约束是**仅同进程内传递**，不落盘、
   * 不入日志、不进错误消息。
   */
  readonly environmentSecret: string;
  readonly extraEnv?: Record<string, string>;
}

/** 未绑定 Agent 配置时的最小启动参数请求（不继承 prompt / Skill / MCP）。 */
export interface MinimalAgentLaunchSpecRequest {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly extraEnv?: Record<string, string>;
}

/** `agent-runtime` 消费、宿主绑定：产出已授权的启动参数。 */
export interface AgentLaunchSpecPort {
  buildAgentLaunchSpec(request: AgentLaunchSpecRequest): Promise<AgentLaunchSpec>;
  buildMinimalAgentLaunchSpec(request: MinimalAgentLaunchSpecRequest): Promise<AgentLaunchSpec>;
}

let boundPort: AgentLaunchSpecPort | null = null;

/** 由 `apps/server` 绑定唯一实现（委托 agent-config 的组装器）。 */
export function bindAgentLaunchSpecPort(port: AgentLaunchSpecPort): void {
  if (boundPort && boundPort !== port) throw new Error("AgentLaunchSpecPort has already been bound");
  boundPort = port;
}

/** 测试用：清空宿主绑定，防止测试进程内状态泄漏。 */
export function resetAgentLaunchSpecPort(): void {
  boundPort = null;
}

/** 取当前生效的组装能力；未装配即失败，禁止隐式创建替代实现。 */
export function getAgentLaunchSpecPort(): AgentLaunchSpecPort {
  if (!boundPort) throw new Error("AgentLaunchSpecPort has not been bound");
  return boundPort;
}
