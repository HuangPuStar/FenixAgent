/**
 * 宿主为 `@fenix/agent-runtime` 的「实例起来之前取什么参数」两个端口提供的实现（CE 阶段 2 任务 1.4 W4a）。
 *
 * 两个端口的**实现都在 `@fenix/agent-config`**：启动参数（`AgentLaunchSpec`）的组装要解析模型、Skill、
 * MCP、知识库与记忆，这些能力属于各资源包的领域；配置查询投影的节点判定（`agentNode` 优先、回退
 * `machineId`）也留在那里。宿主这一层只做三件装配工作：**按模块取得领域服务**、**注入运行期配置与密钥**、
 * **把端口请求翻译成组装器的入参**。翻译这一步无法省：端口说的是「实例属主」（`ownerUserId`），组装器
 * 说的是「用户」（`userId`）——同一个主体在两个语境下各有一个名字，让它们在同一处显式对齐，比给其中
 * 一侧改名要诚实。
 *
 * 与 `resource-module-ports.ts` 同一分工：那里是资源模块路由工厂要的端口，这里是 agent-runtime 要的端口；
 * 都集中在宿主服务层构造一次，`main.ts` 只做接线。
 */

import { getAgentConfigModule } from "@fenix/agent-config/server";
import { createAgentConfigLookup } from "@fenix/agent-config/server/agent-config-lookup";
import {
  createAgentLaunchSpecAssembler,
  type RuntimeCredentialResolver,
} from "@fenix/agent-config/server/agent-launch-spec";
import type { AgentConfigLookupPort, AgentLaunchSpecPort } from "@fenix/agent-runtime/server";
import { createModelService, getModelManagementModule } from "@fenix/model-management/server";
import { getMcpServerModule } from "@fenix/resource-mcp/server";
import { getSkillServerModule } from "@fenix/resource-skill/server";
import { config, getBaseUrl } from "@server/config";
import { resolveSecretReference } from "./resource-module-ports";

export interface PreLaunchPortsDeps {
  /**
   * 模型网关的运行时凭证解析器（网关 Provider 的 apiKey 从这里来）。
   *
   * 未配置网关时省略：组装器遇到 `kind = "gateway"` 的 Provider 会明确失败，不会退回 Provider 行里的
   * 明文 key（见 `model-resolution.ts`）。
   */
  readonly runtimeCredentialResolver?: RuntimeCredentialResolver;
  /**
   * Hindsight（记忆）MCP 的 API token（宿主 env `HINDSIGHT_API_TOKEN`）。
   *
   * 与其它密钥一样只经 launchSpec.env 派发到 machine，不落盘、不入日志；未配置时不注入该变量。
   */
  readonly hindsightApiToken?: string;
}

/** 两个端口都是无状态薄封装；构造一次的产物可直接绑定，重复构造等价。 */
export function createPreLaunchPorts(deps: PreLaunchPortsDeps = {}): {
  readonly launchSpec: AgentLaunchSpecPort;
  readonly lookup: AgentConfigLookupPort;
} {
  const modelManagement = getModelManagementModule();
  const assembler = createAgentLaunchSpecAssembler({
    associations: getAgentConfigModule().associations,
    skills: getSkillServerModule().service,
    mcp: getMcpServerModule().service,
    // Model 领域服务由本包仓储组装：`models` 是 Model 子表仓储，`repositories.provider` 是 Provider 仓储，
    // 两者都是宿主装配出的同一套实例（不是各自新建一份，避免同一装配面出现两组配置）。
    models: createModelService({
      modelRepository: modelManagement.models,
      providerRepository: modelManagement.repositories.provider,
    }),
    env: {
      agentSystemPrompt: config.agentSystemPrompt,
      baseUrl: getBaseUrl(),
      hindsightApiToken: deps.hindsightApiToken,
      // 观测透传：三个键各自独立，未配置的不注入（peri 侧直读同名变量）。
      langfuse: {
        publicKey: config.langfusePublicKey,
        secretKey: config.langfuseSecretKey,
        baseUrl: config.langfuseBaseUrl,
      },
    },
    // `{env:NAME}` 的真相来源是宿主 env，包内不得读 process.env；与资源模块路由共用同一解析实现。
    resolveProviderApiKey: resolveSecretReference,
    resolveRuntimeCredential: deps.runtimeCredentialResolver,
  });

  return {
    launchSpec: {
      buildAgentLaunchSpec: (request) =>
        assembler.buildAgentLaunchSpec({
          organizationId: request.organizationId,
          userId: request.ownerUserId,
          agentConfigId: request.agentConfigId,
          environmentId: request.environmentId,
          environmentSecret: request.environmentSecret,
          extraEnv: request.extraEnv,
        }),
      buildMinimalAgentLaunchSpec: (request) =>
        assembler.buildMinimalLaunchSpec({
          organizationId: request.organizationId,
          userId: request.ownerUserId,
          environmentId: request.environmentId,
          extraEnv: request.extraEnv,
        }),
    },
    lookup: createAgentConfigLookup(),
  };
}
