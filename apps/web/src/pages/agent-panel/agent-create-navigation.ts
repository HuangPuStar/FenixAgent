import type { EnterEnvironmentResponse, EnvironmentDetail } from "@/src/api/environments";

interface CreatedAgentEnvironmentGateway {
  list: () => Promise<EnvironmentDetail[]>;
  create: (body: { name: string; agentConfigId: string; autoStart: boolean }) => Promise<EnvironmentDetail>;
  enter: (environmentId: string) => Promise<EnterEnvironmentResponse>;
}

/** 新建 Agent 后确保关联到真实 Instance，再生成聊天路由目标。 */
export async function resolveCreatedAgentChatTarget(
  agentConfigId: string,
  gateway: CreatedAgentEnvironmentGateway,
): Promise<{ environmentId: string; instanceUid: string }> {
  const environments = await gateway.list();
  const existingEnvironment = environments.find((environment) => environment.agentConfigId === agentConfigId);
  const environment =
    existingEnvironment ??
    (await gateway.create({
      name: `env-${agentConfigId.slice(0, 8)}`,
      agentConfigId,
      autoStart: true,
    }));
  const entered = await gateway.enter(environment.id);
  return { environmentId: entered.environmentId ?? environment.id, instanceUid: entered.instanceUid };
}
