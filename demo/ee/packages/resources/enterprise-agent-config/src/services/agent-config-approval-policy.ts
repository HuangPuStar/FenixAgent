import type { ResourceScope } from "@fenix-ce/platform-sdk";

/**
 * AgentConfig 发布独有的授权扩展端口。
 *
 * 它不属于所有资源共有的 AccessControlModule；甲方可在 app 装配时替换该策略。
 */
export interface AgentConfigApprovalPolicy {
  authorizePublish(input: { actorId: string; agentConfigId: string; ownershipScope: ResourceScope }): Promise<void>;
}
