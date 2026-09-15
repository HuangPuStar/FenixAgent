import type { GatewayBudget } from "@fenix/model-gateway-sdk";
import type { ResolvedModelGatewayCredential, ResolveModelGatewayCredentialInput } from "./credential-service";

export type ModelGatewayRuntimeCredentialResult =
  | {
      status: "ready";
      externalCredentialId: string;
      secret: string;
    }
  | { status: "budget-exhausted" };

export interface ModelGatewayRuntimeCredentialResolverDeps {
  getUserBudget: (gatewayProviderId: string, userId: string) => Promise<GatewayBudget | null>;
  resolveCredential: (input: ResolveModelGatewayCredentialInput) => Promise<ResolvedModelGatewayCredential>;
}

/**
 * 在 Agent 启动时读取 LiteLLM 当前预算，再解析动态 Virtual Key。
 *
 * 预算数据是 LiteLLM 的实时事实来源，因此不能在运行时初始化阶段缓存结果。
 */
export function createModelGatewayRuntimeCredentialResolver(deps: ModelGatewayRuntimeCredentialResolverDeps) {
  return async (input: ResolveModelGatewayCredentialInput): Promise<ModelGatewayRuntimeCredentialResult> => {
    const budget = await deps.getUserBudget(input.gatewayProviderId, input.userId);
    if (budget && budget.maxBudgetUsd !== null && budget.spendUsd >= budget.maxBudgetUsd) {
      return { status: "budget-exhausted" };
    }
    const credential = await deps.resolveCredential(input);
    return { status: "ready", externalCredentialId: credential.externalCredentialId, secret: credential.secret };
  };
}
