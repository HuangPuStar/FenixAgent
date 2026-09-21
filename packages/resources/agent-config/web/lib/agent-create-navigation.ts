// web/lib/agent-create-navigation.ts
// 新建 Agent 成功后「确保进入真实实例 → 生成聊天路由目标」的共享助手。
//
// §1.6 T11e-3c 随 `AgentHomePage` 从 `apps/web/src/pages/agent-panel/` 迁入本包：两个消费方
// （本包首页与宿主壳 `DefaultAppShell` 的「新建智能体」成功回调）都要它，而它只依赖环境 API 的类型，
// 因此按「谁的业务语义」落在 agent-config：入参是 agentConfigId，产出是聊天路由目标。
// 宿主经包 exports 的窄子路径 `@fenix/agent-config/web/lib/agent-create-navigation` 取用——
// 从包根入口取会把整棵编辑器页面图拉进壳层 chunk。
import type { EnterEnvironmentResponse, EnvironmentDetail } from "@fenix/agent-runtime/web/api/environments";

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
