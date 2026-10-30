/**
 * 通道路由校验 Agent 配置可用性的宿主端口。
 *
 * 为什么是端口而不是包内查询：`agent_config` 的可见性与 `use` 动作由 `@fenix/access-control` 与
 * `@fenix/agent-config` 判定，channel 包既不拥有那张表，也不得复制授权规则。宿主在启动期绑定实现，
 * 门面在每次路由写入时调用——**校验的是通道所有者（执行身份）的权限，不是操作者（管理员）自己的权限**。
 *
 * 未绑定时 fail-fast：静默放行会让管理员把路由绑到所有者不可用的 Agent，故障推迟到入站消息才暴露。
 */

/** 端口返回的最小投影；只保留路由视图与运行时需要的字段。 */
export interface ChannelAgentConfigLookupResult {
  readonly id: string;
  readonly name: string;
  readonly engineType: string | null;
}

/** 目标 Agent 配置对通道所有者不可用（不存在、不可读或缺少 `use` 动作）。 */
export class ChannelAgentConfigUnavailableError extends Error {
  constructor(message = "目标 Agent 配置对通道所有者不可用") {
    super(message);
    this.name = "ChannelAgentConfigUnavailableError";
  }
}

/** Agent 配置可用性端口；由宿主装配注入，包内不提供默认实现。 */
export interface ChannelAgentConfigLookup {
  /**
   * 校验 `agentConfigId` 对 `ownerUserId` 可读且具备 `use` 动作，并返回投影。
   *
   * 不可用时抛 {@link ChannelAgentConfigUnavailableError}；数据库等基础设施故障原样上抛，不得伪装成
   * 权限问题。
   */
  requireUsable(input: {
    readonly organizationId: string;
    readonly ownerUserId: string;
    readonly agentConfigId: string;
  }): Promise<ChannelAgentConfigLookupResult>;
}

let boundPort: ChannelAgentConfigLookup | null = null;

/** 由宿主装配阶段绑定一次；重复绑定不同实现直接失败。 */
export function bindChannelAgentConfigLookup(port: ChannelAgentConfigLookup): void {
  if (boundPort && boundPort !== port) throw new Error("ChannelAgentConfigLookup has already been bound");
  boundPort = port;
}

/** 取端口；未装配即报错，不做兜底实现。 */
export function getChannelAgentConfigLookup(): ChannelAgentConfigLookup {
  if (!boundPort) throw new Error("ChannelAgentConfigLookup has not been bound");
  return boundPort;
}

/** 测试用：清空绑定，避免跨用例共享状态。 */
export function resetChannelAgentConfigLookup(): void {
  boundPort = null;
}
