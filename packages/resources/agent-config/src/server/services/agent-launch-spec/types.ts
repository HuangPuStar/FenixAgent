import type { ModelService } from "@fenix/model-management/server";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import type { McpServerService } from "@fenix/resource-mcp/server";
import type { SkillService } from "@fenix/resource-skill/server";
import type { AgentAssociations } from "../agent-associations";

/**
 * 启动参数组装（LaunchSpec）的输入契约。
 *
 * 本模块是「实例起来之前拿什么参数」的权威来源：从 Agent 配置向外解析模型、Skill、MCP、知识库与
 * 记忆，产出 core 侧可直接消费的 `AgentLaunchSpec`。它与「实例起来之后怎么管」（状态机、lease、
 * 限流、disconnect fencing、dispose）严格分离，后者仍在 `agent-runtime`。
 *
 * 依赖只有三类，全部由宿主在装配阶段注入：**其它资源包的包根 Domain Service**（skill / mcp /
 * model-management，按 §2.2 不接受 actor、不做用户授权）、**本包的绑定门面**（绑定表由各资源包拥有）、
 * 以及**运行期配置**（提示词模板、平台基地址、记忆 MCP 的 token）。本模块不读 `process.env`，
 * 也不读宿主 config：包内环境读取会让「包认为已配置、宿主认为未配置」的分歧只能在运行期暴露。
 */

/**
 * 组装需要的运行期配置。
 *
 * 其中三项携带密钥（{@link AgentLaunchSpecEnv.hindsightApiToken} 与 {@link AgentLaunchSpecEnv.langfuse}
 * 的 secretKey）：它们随 launchSpec.env 派发到 machine 上的 agent 进程，属受信 relay 通道传输，
 * 不得落日志，也不得写进 Agent 配置的资源行。
 */
export interface AgentLaunchSpecEnv {
  /** 系统提示词模板（宿主 `config.agentSystemPrompt`）。 */
  readonly agentSystemPrompt: string;
  /** 平台基地址：知识库 MCP 入口为 `${baseUrl}/mcp/knowledge`。 */
  readonly baseUrl: string;
  /** Hindsight（记忆）MCP 的 API token；未配置时不注入该变量。 */
  readonly hindsightApiToken?: string;
  /** Langfuse 观测透传（宿主 `config.langfuse*`）；三个键各自独立，未配置的不注入。 */
  readonly langfuse?: {
    readonly publicKey?: string;
    readonly secretKey?: string;
    readonly baseUrl?: string;
  };
}

/** 模型网关的一次凭证请求：`gatewayProviderId` 是密钥所属的 Provider，其余用于主体复验。 */
export interface RuntimeCredentialInput {
  gatewayProviderId: string;
  organizationId: string;
  userId: string;
  agentConfigId: string;
}

/**
 * 网关凭证结果。
 *
 * `budget-exhausted` 是业务性失败（预算耗尽）而不是基础设施故障：它必须与"解析器不可用"区分开，
 * 前者给用户可读的提示，后者说明部署缺少网关配置。
 */
export type RuntimeCredentialResult =
  | {
      status: "ready";
      externalCredentialId: string;
      secret: string;
    }
  | { status: "budget-exhausted" };

/**
 * 网关凭证解析器；由宿主注入（实现属模型网关领域）。
 *
 * 未注入时遇到 `kind = "gateway"` 的 Provider 直接失败：静默退回 Provider 行里的 apiKey 会把
 * "网关未配置"伪装成"用明文 key 直连上游"。
 */
export type RuntimeCredentialResolver = (input: RuntimeCredentialInput) => Promise<RuntimeCredentialResult>;

export interface AgentLaunchSpecAssemblerDeps {
  /** Agent ↔ Skill / MCP / 知识库 / 记忆的绑定门面（绑定表分散在各自资源包，读写口径只此一处）。 */
  readonly associations: AgentAssociations;
  readonly skills: SkillService;
  readonly mcp: McpServerService;
  readonly models: ModelService;
  readonly env: AgentLaunchSpecEnv;
  /** Provider 行里 `{env:VAR}` 形式的 apiKey 解引用；环境变量的所有权在宿主，故注入。 */
  readonly resolveProviderApiKey: (raw: string | null) => string | null;
  readonly resolveRuntimeCredential?: RuntimeCredentialResolver;
}

/** 按 Agent 配置组装完整启动参数。 */
export interface BuildAgentLaunchSpecInput {
  readonly organizationId: string;
  readonly userId: string;
  /** 环境行绑定的 Agent 配置资源 ID。 */
  readonly agentConfigId: string;
  readonly environmentId?: string;
  /** 环境密钥：仅用于知识库 MCP 的 `Authorization` header（见 assembler 的密钥边界说明）。 */
  readonly environmentSecret: string;
  readonly extraEnv?: Record<string, string>;
}

/** 无 Agent 配置时的最小启动参数：第一个可用模型 + 空资源集。 */
export interface BuildMinimalLaunchSpecInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly environmentId?: string;
  readonly extraEnv?: Record<string, string>;
}

/** 启动参数组装器；由宿主构造并绑定到 `AgentLaunchSpecPort`。 */
export interface AgentLaunchSpecAssembler {
  buildAgentLaunchSpec(input: BuildAgentLaunchSpecInput): Promise<AgentLaunchSpec>;
  buildMinimalLaunchSpec(input: BuildMinimalLaunchSpecInput): Promise<AgentLaunchSpec>;
}
