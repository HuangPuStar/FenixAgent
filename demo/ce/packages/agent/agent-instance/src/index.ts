import type { AgentRuntimeModule } from "@fenix-ce/agent-runtime";

/** 已由上游应用服务解析完成的运行时启动参数。 */
export interface RuntimeLaunchSpec {
  readonly agentId: string;
  readonly engine: string;
}

/** 运行时产生的实例结果，不携带任何资源或授权语义。 */
export interface RuntimeInstanceRunResult {
  readonly instanceId: string;
  readonly engine: string;
  readonly text: string;
}

/**
 * 运行时 Instance 管理器。
 *
 * 它只管理实例标识、运行时调用和未来的复用/停止/租约；不接收 actor，绝不做 AgentConfig 权限判断。
 */
export class AgentInstanceManager {
  private nextInstanceId = 1;

  constructor(
    private readonly runtime: AgentRuntimeModule,
    private readonly instanceIdPrefix: string,
  ) {}

  async run(launchSpec: RuntimeLaunchSpec, prompt: string): Promise<RuntimeInstanceRunResult> {
    const runtimeResult = await this.runtime.run({ agentId: launchSpec.agentId, prompt });
    return {
      ...runtimeResult,
      instanceId: `${this.instanceIdPrefix}-instance-${this.nextInstanceId++}`,
    };
  }
}
