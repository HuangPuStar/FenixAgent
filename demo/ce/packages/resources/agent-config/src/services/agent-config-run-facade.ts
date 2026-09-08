import type { AgentConfigFacade } from "./agent-config-facade";

/** 运行时实现此端口；资源层因此不需要反向依赖 runtime 包。 */
export interface AgentInstanceStarter {
  run(launchSpec: RuntimeLaunchRequest, prompt: string): Promise<RuntimeInstanceRunResult>;
}

/** 资源层向无资源语义的 runtime 传递的启动参数。 */
export interface RuntimeLaunchRequest {
  readonly agentId: string;
  readonly engine: string;
}

/** runtime 返回的通用运行结果。 */
export interface RuntimeInstanceRunResult {
  readonly instanceId: string;
  readonly engine: string;
  readonly text: string;
}

/** 资源层对外返回的运行结果，不暴露 runtime 内部类型。 */
export interface AgentInstanceRunResult {
  readonly instanceId: string;
  readonly agentConfigId: string;
  readonly engine: string;
  readonly text: string;
}

/**
 * AgentConfig 的“使用”应用服务。
 *
 * actor 只在资源层参与 `agent-config:use` 授权；授权完成后才调用抽象的实例启动端口。
 */
export class AgentConfigRunFacade {
  constructor(
    private readonly agentConfigs: AgentConfigFacade,
    private readonly instanceStarter: AgentInstanceStarter,
  ) {}

  async run(input: { actorId: string; agentConfigId: string; prompt: string }): Promise<AgentInstanceRunResult> {
    const launchSpec = await this.agentConfigs.resolveForRun({
      actorId: input.actorId,
      agentConfigId: input.agentConfigId,
    });
    const result = await this.instanceStarter.run(
      { agentId: launchSpec.agentConfigId, engine: launchSpec.engine },
      input.prompt,
    );
    return { ...result, agentConfigId: launchSpec.agentConfigId };
  }
}
