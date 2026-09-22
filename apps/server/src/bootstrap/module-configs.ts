import type { AppConfig } from "../config";
import { getBaseUrl } from "../config";
import { readDeclaredEnv, type ServerEnv } from "../env-loader";

/**
 * 模块配置表：把宿主 env / config 投影成各模块 `getModuleConfig()` 读得到的那一份。
 *
 * 宿主是唯一同时持有已校验 env 与进程级 config 的一层，因此「部署值 → 模块配置」的映射只能在这里做。
 * **必须在 `applyEnv(env)` 之后调用**：本函数读的是 `config` 单例（`getBaseUrl()` 亦然），调用前它还是
 * 空壳默认值。
 *
 * 只列出模块契约声明的字段，不把整个宿主 config 传进去——模块只能读自己的那一份，宿主字段改名必须在
 * 这里被 typecheck 拦住（1.5b 起的既定口径）。
 *
 * 取值有两个来源，选哪个由「值在宿主侧有无加工」决定，不要互串：
 * - `config.*`：宿主已在 `buildConfig` 里做过路径 `resolve()` 或 `??` 兜底（如 `skillDir`、沙盒超时）；
 * - `env.*` / `readDeclaredEnv(env, ...)`：宿主原生键直接透传。模块声明键（1.7 C 块迁出的那批）在
 *   `Env` 类型上已不存在，必须走 `readDeclaredEnv`。
 *
 * 各键的取舍理由随原注释保留（它们解释的是「为什么是这些字段、为什么某些字段故意省略」）。
 */
export function buildModuleConfigs(env: ServerEnv, config: AppConfig): Readonly<Record<string, unknown>> {
  const baseUrl = getBaseUrl();
  return {
    // `betterAuthSecret` 是 better-auth 的签名密钥（1.7 C 块补齐声明 `BETTER_AUTH_SECRET`）：未配置时
    // 不下发，better-auth 按自身语义处理（详见该 manifest 的键说明）。
    identity: {
      betterAuthUrl: readDeclaredEnv<string | undefined>(env, "BETTER_AUTH_URL"),
      rcsBaseUrl: env.RCS_BASE_URL,
      trustedOrigins: readDeclaredEnv<string>(env, "RCS_TRUSTED_ORIGINS"),
      systemAdminPasswordFile: config.systemAdminPasswordFile,
      disableSignup: config.disableSignup,
      betterAuthSecret: readDeclaredEnv<string | undefined>(env, "BETTER_AUTH_SECRET"),
    },
    // Agent Runtime 模块配置：运行态旋钮（三项并发上限、ACP 空闲/巡检/业务超时、WS 保活间隔）、环境解析与
    // `/acp/*` 协议入口的部署值（本地节点开关、兜底机器、workspace 根、注册密钥、file-ws 帧上限），以及启动
    // 组装残留的两个输入（`defaultEngineType` / `baseUrl`）。三项并发上限缺省即「不限制」，`config` 已把 env 的
    // optional 语义原样带过来（`undefined` 而非 0）。启动组装的其余职责随 W4 的 launch-spec 装配搬去
    // agent-config（经 `AgentLaunchSpecPort`），留下的这两个值仍由本包的 `buildAgentLaunchSpecForCore` 消费：
    // 前者决定本地执行的引擎类型，后者注入 platformEnv 的 `USER_META_BASE_URL`；1.5b 起它们与本块其余键同一
    // 路径注入，本包不再直读宿主 `@server/config`。
    "agent-runtime": {
      agentMaxConcurrency: config.agentMaxConcurrency,
      userAgentMaxConcurrency: config.userAgentMaxConcurrency,
      scheduledAgentMaxConcurrency: config.scheduledAgentMaxConcurrency,
      acpIdleTimeoutSeconds: config.acpIdleTimeoutSeconds,
      acpIdleSweepIntervalSeconds: config.acpIdleSweepIntervalSeconds,
      acpActivityTimeoutSeconds: config.acpActivityTimeoutSeconds,
      wsKeepaliveInterval: config.wsKeepaliveInterval,
      defaultMachineId: config.defaultMachineId,
      defaultEngineType: config.defaultEngineType,
      disableLocalExecution: config.disableLocalExecution,
      workspaceRoot: config.workspaceRoot,
      baseUrl,
      acpRegistrySecret: readDeclaredEnv<string>(env, "REGISTRY_SECRET"),
      fileWsMaxPayloadMb: env.RCS_FILE_WS_MAX_PAYLOAD_MB,
      yjsMaxClients: readDeclaredEnv<number>(env, "YJS_MAX_CLIENTS"),
    },
    // 机器模块配置：远程机器兜底 ID 与 file-ws 治理参数，全部来自宿主已校验的 env/config。
    machine: {
      defaultMachineId: config.defaultMachineId,
      fileWsIdentityStrict: config.fileWsIdentityStrict,
      fileEventsMaxClients: config.fileEventsMaxClients,
    },
    // 知识模块配置：RAGFlow 三项与 Gotenberg 地址。四个键的 schema 都归 knowledge 模块声明
    // （1.7 C 块），宿主 `buildConfig` 只做透传，两个地址类键的空串归一已在声明侧完成。
    knowledge: {
      ragflowApiUrl: config.ragflowApiUrl,
      ragflowApiKey: config.ragflowApiKey,
      ragflowRequestTimeoutMs: config.ragflowRequestTimeoutMs,
      gotenbergUrl: config.gotenbergUrl,
    },
    // 记忆模块配置：未配置（或缺省空串）时按「未启用」处理，包侧把空串归一为 undefined。
    memory: { hindsightMcpUrl: readDeclaredEnv<string | undefined>(env, "HINDSIGHT_MCP_URL") },
    // Skill 模块配置：下载目录、对外 baseUrl 与下载 token 的 HMAC 签名密钥候选。
    skill: {
      skillDir: config.skillDir,
      baseUrl,
      downloadTokenSigningKeys: env.RCS_API_KEYS.split(","),
    },
    // AgentConfig 模块配置：侧边栏隐藏项、站点应用代理凭据与 Agent 智能生成用的模型名。
    // 生成模型只在 OpenAI Key 存在时下发，等价于迁移前 `OPENAI_API_KEY && OPENAI_MODEL` 的判定
    // （API Key 由 OpenAI SDK 自行从环境读取，包侧只认模型名是否下发）。`OPENAI_API_KEY` 的声明本身
    // 修好了这条门控：宿主 schema 从未声明过它，迁入声明前该表达式恒为 falsy，生成功能实际不可用。
    "agent-config": {
      hiddenSidebarTabs: readDeclaredEnv<string>(env, "APP_HIDDEN_SIDEBAR_TABS"),
      agentSitesBaseUrl: readDeclaredEnv<string | undefined>(env, "AGENT_SITES_BASE_URL"),
      agentSitesMasterKey: readDeclaredEnv<string | undefined>(env, "AGENT_SITES_MASTER_KEY"),
      agentGenerationModel: readDeclaredEnv<string | undefined>(env, "OPENAI_API_KEY")
        ? readDeclaredEnv<string | undefined>(env, "OPENAI_MODEL")
        : undefined,
    },
    // 沙盒模块配置：显式列出模块契约需要的字段，而不是把整个宿主 config 传进去——
    // 模块只能读自己的那一份，宿主字段改名必须在这里被 typecheck 拦住。
    sandbox: {
      sandboxEnabled: config.sandboxEnabled,
      defaultSandboxPoolId: config.defaultSandboxPoolId,
      defaultSandboxImage: config.defaultSandboxImage,
      defaultSandboxAgentType: config.defaultSandboxAgentType,
      defaultSandboxResourcesJson: config.defaultSandboxResourcesJson,
      defaultSandboxExtraJson: config.defaultSandboxExtraJson,
      openSandboxClusterUrl: config.openSandboxClusterUrl,
      openSandboxClusterApiKey: config.openSandboxClusterApiKey,
      sandboxRuntimeConnectTimeoutMs: config.sandboxRuntimeConnectTimeoutMs,
      sandboxProviderRequestTimeoutMs: config.sandboxProviderRequestTimeoutMs,
      sandboxProviderCreateTimeoutMs: config.sandboxProviderCreateTimeoutMs,
      sandboxProviderResumeTimeoutMs: config.sandboxProviderResumeTimeoutMs,
      sandboxProviderDestroyTimeoutMs: config.sandboxProviderDestroyTimeoutMs,
    },
    // Workflow 模块配置：对外基址（webhook 回调 URL 展示）、acpx-g 代理目标、自定义节点工具目录与
    // run 恢复的 HMAC 签名密钥。`hmacSecret` 未配置时省略，包侧回落「每进程随机签名密钥」——
    // 单实例自洽；多实例部署必须配置该变量，否则跨实例恢复的 run 会签名校验失败。
    workflow: {
      baseUrl,
      acpxGUrl: config.acpxGUrl,
      toolsDir: readDeclaredEnv<string>(env, "WORKFLOW_TOOLS_DIR"),
      hmacSecret: readDeclaredEnv<string | undefined>(env, "RCS_WORKFLOW_HMAC_SECRET"),
    },
    // 模型管理模块配置：网关适配器参数与默认预算。管理密钥与凭据加密密钥未配置时是 `undefined`，
    // 包侧据此判定「网关未启用」而不会退化成无鉴权网关；默认预算周期已由 env schema 把
    // `permanent` / `once` 归一为「未配置」，包侧不再做第二份归一。
    "model-management": {
      modelGatewayType: config.modelGatewayType,
      modelGatewayBaseUrl: config.modelGatewayBaseUrl,
      modelGatewayPublicBaseUrl: config.modelGatewayPublicBaseUrl,
      modelGatewayAdminUiUrl: config.modelGatewayAdminUiUrl,
      modelGatewayAdminKey: config.modelGatewayAdminKey,
      modelGatewayCredentialEncryptionKey: config.modelGatewayCredentialEncryptionKey,
      modelGatewayDefaultUserBudgetUsd: config.modelGatewayDefaultUserBudgetUsd,
      modelGatewayDefaultBudgetDuration: config.modelGatewayDefaultBudgetDuration,
    },
  };
}
