import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { type GitModuleConfig, parseGitModuleConfig } from "@fenix/git/server";
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
    // Agent Runtime 模块配置：运行态旋钮（三项并发上限、ACP 空闲/巡检/业务超时、WS 保活间隔、chat-channel
    // 连接上限与快照节流/TTL 三项）、环境解析与 `/acp/*` 协议入口的部署值（本地节点开关、兜底机器、workspace
    // 根、注册密钥、file-ws 帧上限），以及启动组装残留的两个输入（`defaultEngineType` / `baseUrl`）。三项并发
    // 上限缺省即「不限制」，`config` 已把 env 的 optional 语义原样带过来（`undefined` 而非 0）。启动组装的其余
    // 职责随 W4 的 launch-spec 装配搬去 agent-config（经 `AgentLaunchSpecPort`），留下的这两个值仍由本包的
    // `buildAgentLaunchSpecForCore` 消费：前者决定本地执行的引擎类型，后者注入 platformEnv 的
    // `USER_META_BASE_URL`；1.5b 起它们与本块其余键同一路径注入，本包不再直读宿主 `@server/config`。
    // 快照三项（F1）原先在宿主 `env.ts` 声明、由 chat-channel 持久层直读，本批改为声明在 agent-runtime
    // manifest 并经此处投影，包内直读与包内默认值同批删除。
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
      yjsSnapshotIntervalMs: readDeclaredEnv<number>(env, "RCS_YJS_SNAPSHOT_INTERVAL_MS"),
      yjsSnapshotIdleMs: readDeclaredEnv<number>(env, "RCS_YJS_SNAPSHOT_IDLE_MS"),
      yjsSnapshotTtlSeconds: readDeclaredEnv<number>(env, "RCS_YJS_SNAPSHOT_TTL_SECONDS"),
    },
    // 机器模块配置：远程机器兜底 ID 与 file-ws 治理参数，全部来自宿主已校验的 env/config。
    machine: {
      defaultMachineId: config.defaultMachineId,
      fileWsIdentityStrict: config.fileWsIdentityStrict,
      fileEventsMaxClients: config.fileEventsMaxClients,
    },
    // 公共 Git 模块配置：连接拓扑放在**文件**里（路径由 env 给出），宿主只做「读文件 + 转发两枚凭据」，
    // URL 与 token 引用的合法性、默认超时/并发都由 `parseGitModuleConfig` 判定——宿主不解释连接语义。
    //
    // 未配置（键不存在或空串）时投影空连接且**不读文件**：`buildModuleConfigs` 对所有装配都执行，默认装配
    // （ce.json）不含 git，`AOS_GIT_*` 根本不在 env 里；「启用了 git 却没配置」由 `createGitModule()` 在
    // 产生副作用前报错，本块不替它判定（它不感知 profile）。
    //
    // 配置了路径但读不出来（非绝对路径、文件缺失、JSON 非法）则**启动期直接失败**，不降级成「没有连接」：
    // 静默降级会让部署带着空连接集启动，直到第一次调用才暴露。
    git: ((): GitModuleConfig => {
      const configFilePath = readDeclaredEnv<string | undefined>(env, "AOS_GIT_CONFIG_FILE");
      if (!configFilePath) return { connections: [], secretValues: {} };
      // 相对路径会随启动 cwd 漂移，profile/配置类输入一律要求绝对路径（与 RCS_ASSEMBLY_PROFILE_PATH 同口径）。
      if (!isAbsolute(configFilePath)) {
        throw new Error(`AOS_GIT_CONFIG_FILE 必须是绝对路径: ${configFilePath}`);
      }

      // 两枚凭据只在配置了连接时才读：git 未进入装配 profile 时这两个键不在 env 里，读到的会是 undefined。
      // 配置里的 `{env:NAME}` 引用只能指向 manifest 已声明的键，因此这里只投影这两个。
      const secretValues = {
        AOS_GIT_PROVISION_TOKEN: readDeclaredEnv<string>(env, "AOS_GIT_PROVISION_TOKEN"),
        AOS_GIT_SERVICE_TOKEN: readDeclaredEnv<string>(env, "AOS_GIT_SERVICE_TOKEN"),
      };

      let source: string;
      try {
        source = readFileSync(configFilePath, "utf8");
      } catch (error) {
        // 只带路径：文件内容可能含凭据引用，不进错误消息与日志。
        throw new Error(`AOS_GIT_CONFIG_FILE 读取失败: ${configFilePath}`, { cause: error });
      }

      return parseGitModuleConfig(source, secretValues);
    })(),
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
    // 插件市场模块配置：npm 私有源五键全部**直接透传**模块声明值，不经宿主 config。
    // 取舍依据见本文件头「取值有两个来源」：宿主侧对这五个值没有任何加工（不需 resolve、不需兜底），
    // 声明侧已完成空串归一与默认值，再经 config 中转一次只是把同一个值抄到第二个地方。
    // 先例是同一处理由下的 `agent-config` 的 AGENT_SITES_BASE_URL / APP_HIDDEN_SIDEBAR_TABS。
    // 未配置源地址时 registryUrl 为 null（而非 undefined）：包内契约 `PluginMarketModuleConfig` 用
    // `.nullable()` 表达「未配置」，使这个部署状态在类型上可见，不必让读的人区分 undefined 的两种含义。
    "plugin-market": {
      sourceId: readDeclaredEnv<string>(env, "PLUGIN_MARKET_SOURCE_ID"),
      registryUrl: readDeclaredEnv<string | undefined>(env, "PLUGIN_MARKET_REGISTRY_URL") ?? null,
      registryToken: readDeclaredEnv<string | undefined>(env, "PLUGIN_MARKET_REGISTRY_TOKEN") ?? null,
      registryTimeoutMs: readDeclaredEnv<number>(env, "PLUGIN_MARKET_REGISTRY_TIMEOUT_MS"),
      registryMaxBytes: readDeclaredEnv<number>(env, "PLUGIN_MARKET_REGISTRY_MAX_BYTES"),
    },
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
    // Workflow V2 模块配置：九枚键全部是本模块自己声明的部署键（`fenix.module.ts` 的 envDefinitions，
    // 冻结 §2.2），宿主只做透传。2F 起模块已在 `deploy/assembly/ce.json` 的 `resources` 列表里，
    // `loadServerEnv` 因此聚合了这九枚键，三枚必填项已在启动期由声明方 schema 校验，这里取到的都是已解析值。
    // `nodeWhitelist` 传逗号分隔**字符串**（声明面的形状），拆成类型名数组是包内 `getWorkflowV2Config()`
    // 的职责：节点类型名是 workflow-v2 的领域知识，宿主不解释它。
    "workflow-v2": {
      upstreamBaseUrl: readDeclaredEnv<string>(env, "WORKFLOW_V2_UPSTREAM_BASE_URL"),
      canvasUpstreamUrl: readDeclaredEnv<string>(env, "WORKFLOW_CANVAS_UPSTREAM_URL"),
      // 可选键（2026-10-12）：未配置即 `undefined`＝存储出站直连直链 origin。不给默认值、不做空串归一——
      // 「空串」在模块 schema 里是非法地址而不是「未配置」，两者不能混成一个形状。
      storageUpstreamUrl: readDeclaredEnv<string | undefined>(env, "WORKFLOW_V2_STORAGE_UPSTREAM_URL"),
      accountEmail: readDeclaredEnv<string>(env, "WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL"),
      accountPassword: readDeclaredEnv<string>(env, "WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD"),
      ticketSecret: readDeclaredEnv<string>(env, "WORKFLOW_V2_TICKET_SECRET"),
      codeTtlSeconds: readDeclaredEnv<number>(env, "WORKFLOW_V2_IFRAME_CODE_TTL_SECONDS"),
      ticketTtlSeconds: readDeclaredEnv<number>(env, "WORKFLOW_V2_IFRAME_TICKET_TTL_SECONDS"),
      upstreamTimeoutMs: readDeclaredEnv<number>(env, "WORKFLOW_V2_UPSTREAM_TIMEOUT_MS"),
      nodeWhitelist: readDeclaredEnv<string>(env, "WORKFLOW_V2_NODE_WHITELIST"),
      reconcileIntervalSeconds: readDeclaredEnv<number>(env, "WORKFLOW_V2_RECONCILE_INTERVAL_SECONDS"),
      bffRateLimitPerMinute: readDeclaredEnv<number>(env, "WORKFLOW_V2_BFF_RATE_LIMIT_PER_MINUTE"),
      sessionRateLimitPerMinute: readDeclaredEnv<number>(env, "WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE"),
      apiRateLimitPerMinute: readDeclaredEnv<number>(env, "WORKFLOW_V2_API_RATE_LIMIT_PER_MINUTE"),
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
    // Trace 观测模块配置：与 Agent 侧上报用的是**同一组**连接参数（`LANGFUSE_*`，声明 owner 是
    // agent-config），本模块只是控制台侧的读取方，故不重复声明环境键，只在这里把已解析的三个值投影过去。
    // 缺任一键即「观测读取未启用」，包侧据此返回 configured=false 而不是发一次注定 401 的请求。
    trace: {
      langfuseBaseUrl: config.langfuseBaseUrl,
      langfusePublicKey: config.langfusePublicKey,
      langfuseSecretKey: config.langfuseSecretKey,
    },
  };
}
