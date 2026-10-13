import { log, error as logError } from "@fenix/logger";
import { AppError } from "@fenix/platform-sdk";
import type { ModelConfig } from "@fenix/plugin-sdk";
import type { ScopedAgentConfigRow } from "../../repositories/agent-config-resource";
import { LAUNCH_SPEC_LOG_PREFIX, throwInvalidConfig, toLaunchModelProtocol } from "./support";
import type { AgentLaunchSpecAssemblerDeps } from "./types";

/**
 * 模型解析：把 Agent 配置上的 `modelId` 解析成 runtime 可直接消费的 {@link ModelConfig}。
 *
 * 数据来源是 `model-management` 的包根 Domain Service（无授权、按组织范围读）：Provider 与 Model 的
 * 排序规则（`PROVIDER_LIST_ORDER` / `MODEL_LIST_ORDER`）属于那个包的领域知识，本模块只表达
 * "要一个可用的"，不再自己拼 SQL——否则同一份排序会在两个包里各写一遍，先选到哪个模型取决于谁先改。
 */

/** 解析失败一律走 {@link throwInvalidConfig}：这些都是配置问题，不是运行时故障。 */
function invalidConfig(message: string, detail: string): never {
  return throwInvalidConfig(message, detail);
}

/**
 * 解析 Agent 配置引用的模型；未指定 `modelId` 时回退到组织内第一个可用模型。
 *
 * `userId` 是**实例属主**，只用于网关凭证：网关凭证按"谁在跑这个 Agent"签发，与主体复验同一个主体。
 * 与之相对，回退选模型用的用户标识取 **Agent 配置的属主**（`agentConfig.userId`）——那条回退表达的
 * 是"这个配置自己没有指定模型"，沿用配置自身的归属语境。
 */
export async function resolveModelConfig(
  deps: AgentLaunchSpecAssemblerDeps,
  agentConfig: ScopedAgentConfigRow,
  userId: string,
): Promise<ModelConfig> {
  if (!agentConfig.modelId) {
    log(
      `${LAUNCH_SPEC_LOG_PREFIX} agentConfig '${agentConfig.id}' has no modelId, falling back to first available model in org '${agentConfig.organizationId}'`,
    );
    return resolveFirstConfiguredModel(deps, {
      organizationId: agentConfig.organizationId,
      userId: agentConfig.userId ?? agentConfig.organizationId,
    });
  }

  const matchedModel = await deps.models.findModelRowUnscoped(agentConfig.modelId);
  if (!matchedModel) {
    invalidConfig(
      `AgentConfig '${agentConfig.id}' references missing model id '${agentConfig.modelId}'`,
      `${LAUNCH_SPEC_LOG_PREFIX} missing model row by modelId for agentConfig='${agentConfig.id}', modelId='${agentConfig.modelId}'`,
    );
  }

  // 组织条件同时校验：模型行冗余了 `organization_id`，跨组织的脏数据不能拼成一份启动参数。
  const matchedProvider = await deps.models.findProviderRowUnscoped({
    providerId: matchedModel.providerId,
    organizationId: matchedModel.organizationId,
  });
  if (!matchedProvider) {
    invalidConfig(
      `AgentConfig '${agentConfig.id}' references missing provider for model '${agentConfig.modelId}'`,
      `${LAUNCH_SPEC_LOG_PREFIX} missing provider row for agentConfig='${agentConfig.id}', modelId='${agentConfig.modelId}', providerId='${matchedModel.providerId}'`,
    );
  }

  log(
    `${LAUNCH_SPEC_LOG_PREFIX} resolveModelConfig: resolved modelId='${agentConfig.modelId}' to provider='${matchedProvider.organizationId}/${matchedProvider.id}', model='${matchedModel.modelId}'`,
  );

  let apiKey = deps.resolveProviderApiKey(matchedProvider.apiKey) ?? "";
  if (matchedProvider.kind === "gateway") {
    apiKey = await resolveGatewayApiKey(deps, {
      providerId: matchedProvider.id,
      organizationId: agentConfig.organizationId,
      agentConfigId: agentConfig.id,
      userId,
    });
  }

  return {
    provider: matchedProvider.name,
    protocol: toLaunchModelProtocol(matchedProvider.protocol, matchedProvider.name, agentConfig.id),
    baseUrl: matchedProvider.baseUrl || "",
    apiKey,
    model: matchedModel.modelId,
    // opencode / ccb 引擎用 modelName 作为运行时模型标识（如 ANTHROPIC_MODEL 环境变量）。
    // 数据库 model.modelId 即用户配置的模型名（如 deepseek-v4-flash），直接透传。
    modelName: matchedModel.modelId,
    modalities: matchedModel.modalities ?? undefined,
  };
}

/**
 * 网关 Provider 的密钥来自宿主注入的凭证服务，而不是 Provider 行里的 apiKey。
 *
 * 用户标识取**实例属主**（请求入参）而不是配置属主：网关凭证是按"谁在跑这个 Agent"签发的，
 * 主体复验（`SubjectVerificationPort`）用的也是这个 `userId`，两处必须同一个主体。
 */
async function resolveGatewayApiKey(
  deps: AgentLaunchSpecAssemblerDeps,
  input: { providerId: string; organizationId: string; agentConfigId: string; userId: string },
): Promise<string> {
  const resolver = deps.resolveRuntimeCredential;
  if (!resolver) {
    invalidConfig(
      `AgentConfig '${input.agentConfigId}' requires a configured model gateway`,
      `${LAUNCH_SPEC_LOG_PREFIX} model gateway resolver is not configured for agentConfig='${input.agentConfigId}'`,
    );
  }
  const credential = await resolver({
    gatewayProviderId: input.providerId,
    organizationId: input.organizationId,
    userId: input.userId,
    agentConfigId: input.agentConfigId,
  });
  if (credential.status === "budget-exhausted") {
    const message = "模型网关预算已耗尽，无法启动 Agent";
    logError(
      `${LAUNCH_SPEC_LOG_PREFIX} ${message}: agentConfig='${input.agentConfigId}', user='${input.userId}', provider='${input.providerId}'`,
    );
    throw new AppError(message, "MODEL_GATEWAY_BUDGET_EXHAUSTED", 400);
  }
  return credential.secret;
}

/**
 * 为「无 AgentConfig 绑定」的最小启动路径解析一个可运行模型。
 *
 * 1. 不继承任何 prompt / skill / MCP
 * 2. 仅从当前用户可读的 provider/model 中挑第一个可用项
 * 3. 如果一个模型都没有，则直接报错，引导用户先完成基础模型配置
 */
export async function resolveFirstConfiguredModel(
  deps: AgentLaunchSpecAssemblerDeps,
  input: { organizationId: string; userId: string; environmentId?: string },
): Promise<ModelConfig> {
  const configured = await deps.models.findFirstConfiguredByOrganizationUnscoped(input.organizationId);
  if (!configured) {
    invalidConfig(
      "Default agent requires at least one configured model. Please configure a model first, then retry.",
      `${LAUNCH_SPEC_LOG_PREFIX} resolveFirstConfiguredModel: no readable model for org='${input.organizationId}', user='${input.userId}', environmentId='${input.environmentId ?? ""}'. minimal launch spec requires at least one readable model`,
    );
  }

  log(
    `${LAUNCH_SPEC_LOG_PREFIX} resolveFirstConfiguredModel: selected provider='${configured.provider.organizationId}/${configured.provider.id}', model='${configured.model.modelId}'`,
  );
  return {
    provider: configured.provider.name,
    protocol: toLaunchModelProtocol(
      configured.provider.protocol,
      configured.provider.name,
      input.environmentId ?? "minimal",
    ),
    baseUrl: configured.provider.baseUrl || "",
    apiKey: deps.resolveProviderApiKey(configured.provider.apiKey) ?? "",
    model: configured.model.modelId,
    modelName: configured.model.modelId,
    modalities: configured.model.modalities ?? undefined,
  };
}
