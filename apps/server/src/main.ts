import { createLogger, interceptConsole } from "@fenix/logger";

// ⚠️ 必须在所有其他代码之前拦截 console，保证全局日志统一
interceptConsole();

const startupLog = createLogger("rcs");

import { createDrizzleAccessControl } from "@fenix/access-control/suite";
import {
  agentConfigResource,
  createAgentConfigServerModule,
  createAgentSitesCompatRoutes,
  createAgentSitesProxyRoutes,
  createApiAgentsRoutes,
  getAgentConfigModule,
  installAgentConfigModule,
  setMetaAgentModelResolver,
} from "@fenix/agent-config/server";
import { createAgentRuntimeModule } from "@fenix/agent-runtime/runtime";
import {
  bindAcpInstanceActivityPort,
  bindAgentConfigLookupPort,
  bindAgentLaunchSpecPort,
  bindCoreRuntimePort,
  bindEnvironmentAcpLifecyclePort,
  bindFileWsPort,
  bindLocalNodeAgentNodeServicePort,
  bindMachineRegistryPort,
  bindRedisConnectionPort,
  bindSessionEventBusPort,
  createAcpRoutes,
  createApiInstanceRoutes,
  createOpenaiChatRoutes,
  environmentRepo,
  findMachineConnectionById,
  getAcpEventBus,
  getAgentNodeService,
  getAllEventBuses,
  removeEventBus,
  resolveWorkspacePath,
  triggerMachineCleanupByMachineId,
} from "@fenix/agent-runtime/server";
import { createApiSystemRoutes, createIdentityDirectory, ensureSystemAdmin } from "@fenix/identity/server";
import {
  createApiModelsRoutes,
  createApiSystemModelGatewayRoutes,
  createModelGatewayRuntime,
  createModelManagementServerModule,
  createSystemModelGatewayProviderService,
  getModelManagementModule,
  installModelManagementModule,
  providerResource,
} from "@fenix/model-management/server";
import {
  getIdentityDirectory,
  initializeApplicationInfrastructure,
  registerIdentityDirectory,
} from "@fenix/platform-sdk/server";
import { bindAcpEventBusPort, getHermesClient, initHermesClient } from "@fenix/resource-channel/server";
import { checkRagFlowHealth, createApiKnowledgeBaseRoutes } from "@fenix/resource-knowledge/server";
import {
  bindMachineEnvironmentPort,
  bindMachineHostPort,
  checkParsedObjectSize,
  checkWsMessageSize,
  closeAllFileWsConnections,
  createApiWorkspaceRoutes,
  disconnectMachine,
  estimateWsMessageBytes,
  formatFileWsCloseLog,
  handleFileWsClose,
  handleFileWsMessage,
  handleFileWsOpen,
  handleHeartbeat,
  LocalNodeAwareService,
  parseFileWsMessage,
  registerMachine,
  startFileWsSweep,
  startHeartbeat,
  startMachineSweep,
  stopFileWsSweep,
  stopHeartbeat,
} from "@fenix/resource-machine/server";
import {
  createApiMcpRoutes,
  createMcpServerServerModule,
  installMcpServerModule,
  knowledgeMcpRoutes,
  mcpServerResource,
} from "@fenix/resource-mcp/server";
import {
  createApiSystemLogsRoutes,
  createApiSystemObserverRoutes,
  createApiSystemPeopleTreeRoutes,
} from "@fenix/resource-observer/server";
import {
  createApiSandboxClusterRoutes,
  createApiSandboxRoutes,
  createApiSandboxServerRoutes,
  initializeDefaultSandboxPool,
  registerConfiguredSandboxProviders,
  sandboxManager,
} from "@fenix/resource-sandbox/server";
import {
  createApiSkillsRoutes,
  createSkillServerModule,
  installSkillServerModule,
  skillDownloadRoutes,
  skillResource,
} from "@fenix/resource-skill/server";
import { schedulerService } from "@fenix/resource-task/server";
import {
  createApiWorkflowRoutes,
  createWorkflowStaticApp,
  initCustomToolsRegistry,
} from "@fenix/resource-workflow/server";
import type { WebSocketHandler } from "bun";
import Elysia from "elysia";
import { startSchedulerUnlessDisabled } from "./bootstrap/scheduler-startup";
import { runCriticalStartupSequence } from "./bootstrap/startup-sequence";
import { applyEnv, config, getBaseUrl } from "./config";
import { db, initDb, client as pgClient } from "./db";
import { findDeprecatedEnvVars } from "./env";
import { loadServerEnv } from "./env-loader";
import { createExternalOpenApiPlugin, createWebOpenApiPlugin } from "./openapi";
import {
  authenticateRequest,
  authenticateSiteRequest,
  authGuardPlugin,
  authPlugin,
  toActorContext,
} from "./plugins/auth";
import { corsPlugin } from "./plugins/cors";
import { errorPlugin } from "./plugins/error-handler";
import { deriveRequestId, injectRequestId, logError, logRequest, logResponse } from "./plugins/logger";
import { ctrlStaticPlugin } from "./plugins/static";
import { systemApiAuthPlugin } from "./plugins/system-api-auth";
import webApp from "./routes/web";
import { buildHealthInfo } from "./services/build-info";
import { closeCache, getRedisConnection } from "./services/cache";
import { getCoreRuntime, initCoreRuntime, registerRemoteNode, unregisterRemoteNode } from "./services/core-bootstrap";
import { runDataMigrations } from "./services/data-migrate";
import { createModelGatewaySubjectVerification } from "./services/model-gateway-subject-verification";
import { createPreLaunchPorts, type PreLaunchPortsDeps } from "./services/pre-launch-ports";
import { syncBuiltin } from "./services/sync-builtin";

/**
 * Meta Agent 的默认模型解析：取当前主体可见的第一个 Provider 的第一个模型。
 *
 * 返回的是 `model` 表的行 ID——`agent_config.model_id` 是它的外键（运行时只认这个外键，不接受
 * `provider/modelId` 形式的引用），因此这里不能返回模型业务键。
 *
 * 读取一律经 Facade：授权与可见性由资源包的授权谓词决定，宿主不再自己拼资源键。
 */
setMetaAgentModelResolver(async (ctx) => {
  const actor = toActorContext(ctx);
  const { facade } = getModelManagementModule();
  const { items } = await facade.list(actor);
  for (const item of items) {
    const detail = await facade.getById(actor, item.id);
    const firstModel = detail?.models[0];
    if (firstModel) return firstModel.id;
  }
  return null;
});

const startedAt = new Date().toISOString();

const env = loadServerEnv([]);
applyEnv(env);

// 平台模块只能经 `@fenix/platform-sdk/server` 读取基础设施，因此宿主必须在任何模块开始工作前完成
// 唯一初始化。身份目录同样只允许注册一次：两个身份实现并存会让不同模块读到不一致的成员关系视图，
// 而这类分歧不会在启动期暴露。
initializeApplicationInfrastructure({
  database: db,
  moduleConfigs: {
    identity: {
      betterAuthUrl: env.BETTER_AUTH_URL,
      rcsBaseUrl: env.RCS_BASE_URL,
      trustedOrigins: env.RCS_TRUSTED_ORIGINS,
      systemAdminPasswordFile: config.systemAdminPasswordFile,
      disableSignup: config.disableSignup,
    },
    // Agent Runtime 模块配置：运行态旋钮（三项并发上限、ACP 空闲/巡检/业务超时、WS 保活间隔）加环境解析与
    // `/acp/*` 协议入口的部署值（本地节点开关、兜底机器、workspace 根、注册密钥、file-ws 帧上限）。三项并发
    // 上限缺省即「不限制」，`config` 已把 env 的 optional 语义原样带过来（`undefined` 而非 0）。「启动参数
    // 组装」类配置不在这里：那部分职责随 W4 的 launch-spec 装配搬出本包（见 §七 W1/W2/W4 产出栏）。
    "agent-runtime": {
      agentMaxConcurrency: config.agentMaxConcurrency,
      userAgentMaxConcurrency: config.userAgentMaxConcurrency,
      scheduledAgentMaxConcurrency: config.scheduledAgentMaxConcurrency,
      acpIdleTimeoutSeconds: config.acpIdleTimeoutSeconds,
      acpIdleSweepIntervalSeconds: config.acpIdleSweepIntervalSeconds,
      acpActivityTimeoutSeconds: config.acpActivityTimeoutSeconds,
      wsKeepaliveInterval: config.wsKeepaliveInterval,
      defaultMachineId: config.defaultMachineId,
      disableLocalExecution: config.disableLocalExecution,
      workspaceRoot: config.workspaceRoot,
      acpRegistrySecret: env.REGISTRY_SECRET,
      fileWsMaxPayloadMb: env.RCS_FILE_WS_MAX_PAYLOAD_MB,
    },
    // 机器模块配置：远程机器兜底 ID 与 file-ws 治理参数，全部来自宿主已校验的 env/config。
    machine: {
      defaultMachineId: config.defaultMachineId,
      fileWsIdentityStrict: config.fileWsIdentityStrict,
      fileEventsMaxClients: config.fileEventsMaxClients,
    },
    // 知识模块配置：RAGFlow 三项与 Gotenberg 地址。`GOTENBERG_URL` 尚未进宿主 env schema
    // （变量收敛归 §1.7），这里先按迁移前的默认值读取，避免把部署知识搬进资源包。
    knowledge: {
      ragflowApiUrl: config.ragflowApiUrl,
      ragflowApiKey: config.ragflowApiKey,
      ragflowRequestTimeoutMs: config.ragflowRequestTimeoutMs,
      gotenbergUrl: config.gotenbergUrl,
    },
    // 记忆模块配置：未配置（或缺省空串）时按「未启用」处理，包侧把空串归一为 undefined。
    memory: { hindsightMcpUrl: env.HINDSIGHT_MCP_URL },
    // Skill 模块配置：下载目录、对外 baseUrl 与下载 token 的 HMAC 签名密钥候选。
    skill: {
      skillDir: config.skillDir,
      baseUrl: getBaseUrl(),
      downloadTokenSigningKeys: env.RCS_API_KEYS.split(","),
    },
    // AgentConfig 模块配置：侧边栏隐藏项、站点应用代理凭据与 Agent 智能生成用的模型名。
    // 生成模型只在 OpenAI Key 存在时下发，等价于迁移前 `OPENAI_API_KEY && OPENAI_MODEL` 的判定
    // （API Key 由 OpenAI SDK 自行从环境读取，包侧只认模型名是否下发）。
    "agent-config": {
      hiddenSidebarTabs: env.APP_HIDDEN_SIDEBAR_TABS,
      agentSitesBaseUrl: env.AGENT_SITES_BASE_URL,
      agentSitesMasterKey: env.AGENT_SITES_MASTER_KEY,
      agentGenerationModel: env.OPENAI_API_KEY ? env.OPENAI_MODEL : undefined,
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
    // Workflow 模块配置：对外基址（webhook 回调 URL 展示）、acpx-g 代理目标与自定义节点工具目录。
    // `hmacSecret` 这里省略：宿主 env schema 尚未声明 `RCS_WORKFLOW_HMAC_SECRET`（变量声明与 preflight
    // 收敛归任务 1.7），省略即回到迁移前的「每进程随机签名密钥」——单实例自洽；多实例部署补声明该变量后
    // 必须在这里一并下发，否则跨实例恢复的 run 会签名校验失败。
    workflow: {
      baseUrl: getBaseUrl(),
      acpxGUrl: config.acpxGUrl,
      toolsDir: env.WORKFLOW_TOOLS_DIR,
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
  },
});
registerIdentityDirectory(createIdentityDirectory());
// 运行 port（1.4 W3b）：实例/环境生命周期与会话数据面只有这一个入口，宿主在装配阶段绑定一次，
// 路由与消费包随后经 `getBoundAgentRuntime()` 取用。同时由本模块的 create 绑定包内编排 seam
//（§4.6：`AgentInstanceRuntimeOperations` 是包内装配细节，宿主不再把包导出的函数转发回去）。
// §1.5 的 registry 驱动装配接管后，这一行由模块 create 承担。
const agentRuntime = createAgentRuntimeModule().runtime;
bindCoreRuntimePort({ getCoreRuntime, registerRemoteNode, unregisterRemoteNode });
bindMachineRegistryPort({ registerMachine, disconnectMachine, handleHeartbeat, startHeartbeat, stopHeartbeat });
// Machine 包的宿主运行态：workspace 根、Core runtime 节点、file-ws 连接索引与断连清理都是宿主进程级单例，
// 包不反向导入 agent-runtime 取值，改由这里一次绑定（未装配时包内调用即失败，不隐式回退）。
bindMachineHostPort({
  resolveWorkspacePath,
  // Core runtime 单例归宿主（`./services/core-bootstrap`），此处只暴露「按 machineId 查节点」的窄视图。
  getCoreRuntimeNode: (machineId) => getCoreRuntime().getNode(machineId),
  unregisterCoreRuntimeNode: unregisterRemoteNode,
  findMachineConnectionById,
  triggerMachineCleanupByMachineId,
});
// Machine 包读 environment 的两个原语（记录读取 + 归属校验）：实现仍在 agent-runtime，由此处转发。
bindMachineEnvironmentPort({
  getEnvironmentById: (environmentId) => environmentRepo.getById(environmentId),
  getOwnedEnvironment: agentRuntime.getOwnedEnvironment,
});
// YJS 会话快照所需的 Redis 连接（1.4 W2）：包内不再 import 宿主 services/cache，连接的建立与配置
// 由宿主绑定，包内仅在会话切换的 CAS 快照路径上取用（未配置 RCS_REDIS_URL 时返回 null 并跳过）。
bindRedisConnectionPort({ getRedisConnection });
bindSessionEventBusPort({
  getAllBuses: () => getAllEventBuses(),
  removeBus: (sessionId) => removeEventBus(sessionId),
});
bindLocalNodeAgentNodeServicePort({
  getAgentNodeService: () => new LocalNodeAwareService(getAgentNodeService),
});
bindAcpEventBusPort({ getAcpBus: (agentId) => getAcpEventBus(agentId) });
bindFileWsPort({
  checkParsedObjectSize,
  checkWsMessageSize,
  estimateWsMessageBytes,
  formatFileWsCloseLog,
  handleFileWsClose,
  handleFileWsMessage,
  handleFileWsOpen,
  parseFileWsMessage,
});
bindEnvironmentAcpLifecyclePort({
  closeAcpConnections: agentRuntime.closeAcpConnectionsForEnvironments,
  stopInstances: agentRuntime.stopInstancesForEnvironments,
});
bindAcpInstanceActivityPort(agentRuntime.touchInstanceActivity);
// 模型网关的运行时凭证解析器：在启动序列里解析后交给 agent-config 的启动参数组装器
// （见下方 `createPreLaunchPorts` + 端口绑定）。W4b 删掉 agent-runtime 的旧解析器槽位后，
// 这是唯一注入点：组装器遇到 `kind = "gateway"` 的 Provider 时用它换签发凭证。
let runtimeCredentialResolver: PreLaunchPortsDeps["runtimeCredentialResolver"];
await runCriticalStartupSequence({
  initDb: async () => {
    await initDb();
    startupLog.info("Database initialized");
  },
  wirePermissions: () => {
    // 模型网关与 builtin 都会查询资源授权，必须在业务资源初始化前完成宿主装配。
    // MCP / Skill / AgentConfig / Provider 资源使用同一授权栈：归属列在主表，授权谓词与分页/计数由
    // 同一份资源注册下推到 SQL。
    const accessControlSuite = createDrizzleAccessControl({
      database: db,
      bindings: [
        mcpServerResource.storage,
        skillResource.storage,
        agentConfigResource.storage,
        providerResource.storage,
      ],
    });
    const moduleDeps = {
      accessControl: accessControlSuite.accessControl,
      scopeStore: accessControlSuite.scopeStore,
      authorizedQuery: accessControlSuite.authorizedQuery,
      identity: getIdentityDirectory(),
    };
    installMcpServerModule(createMcpServerServerModule(moduleDeps));
    installSkillServerModule(createSkillServerModule(moduleDeps));
    installAgentConfigModule(createAgentConfigServerModule(moduleDeps));
    installModelManagementModule(createModelManagementServerModule(moduleDeps));
  },
  initModelGateway: async () => {
    registerConfiguredSandboxProviders();

    // 部署侧配置旧变量时显式提示，避免死配置被 zod strip 静默丢弃。
    for (const { name, replacement } of findDeprecatedEnvVars()) {
      startupLog.warn(
        `Deprecated environment variable ${name} is ignored; use ${replacement} instead (local execution only, remote engine is controlled by machine-side AGENT_TYPE)`,
      );
    }

    // 先应用 env，再跑系统初始化：system admin 需要读取密码文件路径配置。
    const systemAdmin = await ensureSystemAdmin();
    startupLog.info(`System admin ready: ${systemAdmin.email}`);

    // 数据迁移仍要早于 builtin 同步，避免旧数据结构影响系统资源落盘位置。
    await runDataMigrations();
    startupLog.info("Data migrations completed");

    // 上游凭据的主体复验端口：用已装配的授权能力 + agent_config 的资源定义，与平台其它入口判定
    // Agent 可用性的是同一条规则（见 `services/model-gateway-subject-verification`）。
    const modelManagement = getModelManagementModule();
    const subjectVerification = createModelGatewaySubjectVerification({
      accessControl: modelManagement.accessControl,
      identity: modelManagement.identity,
      findAgentConfigOrganization: async (agentConfigId) =>
        (await getAgentConfigModule().service.findRowUnscoped(agentConfigId))?.organizationId,
    });

    const modelGatewayRuntime = createModelGatewayRuntime({ subjectVerification });
    if (modelGatewayRuntime) {
      await modelGatewayRuntime.services.provider.ensureProvider();
      runtimeCredentialResolver = modelGatewayRuntime.resolveRuntimeCredential;
      startupLog.info("Model gateway runtime initialized");
      return;
    }

    // Provider 投影即使未配置管理凭证也需要存在，便于管理端显示待配置状态。
    await createSystemModelGatewayProviderService(
      {},
      {
        baseUrl: config.modelGatewayPublicBaseUrl,
        gatewayType: config.modelGatewayType,
      },
    ).ensureProvider();
  },
});

// agent-runtime 的「启动前取数」两个端口（启动参数组装 + Agent 配置查询）：实现在 agent-config，宿主
// 装配后绑定（见 `services/pre-launch-ports.ts`）。绑定点必须在 `wirePermissions` 之后——那时 agent-config /
// skill / mcp / model-management 四个模块才装配完成；也必须在本行之后才能拿到模型网关凭证解析器。
const preLaunchPorts = createPreLaunchPorts({
  runtimeCredentialResolver,
  hindsightApiToken: env.HINDSIGHT_API_TOKEN,
});
bindAgentLaunchSpecPort(preLaunchPorts.launchSpec);
bindAgentConfigLookupPort(preLaunchPorts.lookup);
startupLog.info("Pre-launch ports bound (agent launch spec / agent config lookup)");

// 沙盒默认池初始化与崩溃恢复（Sandbox 能力，早于 core runtime 启动）。
// 失败不阻断启动：沙盒不可用时仅影响沙盒执行节点，普通执行路径不受影响。
try {
  // 配置由包自己经 `getModuleConfig("sandbox")` 读取，宿主不再把整个 config 传进模块。
  const defaultPool = await initializeDefaultSandboxPool();
  if (defaultPool) startupLog.info(`Default sandbox pool initialized: ${defaultPool.id}`);
} catch (error) {
  startupLog.error("Failed to initialize default sandbox pool", error instanceof Error ? error : undefined);
}

await sandboxManager.recoverAfterRestart();

await initCoreRuntime();
startupLog.info("Core runtime initialized");

await startSchedulerUnlessDisabled({
  disabled: env.RCS_DISABLE_SCHEDULER,
  start: () => schedulerService.start(),
  onDisabled: () => startupLog.info("Scheduler startup disabled by RCS_DISABLE_SCHEDULER"),
});

try {
  // builtin 资源现在统一托管到系统 admin 组织，不再在启动时遍历所有组织复制副本。
  await syncBuiltin();
  startupLog.info("Builtin resources synced");
} catch (err) {
  startupLog.error("Failed to sync builtin resources", err instanceof Error ? err : undefined);
}

// 初始化自定义节点工具注册表：扫描 WORKFLOW_TOOLS_DIR，注册 SlurmNode 子类。
// 必须在 getTeamEngine() 调用前完成，否则 yaml 中 type: custom 的节点会因 tool 未注册而失败。
// discover 内部已捕获异常并 fallback 到空 registry，不会阻塞服务启动。
await initCustomToolsRegistry();
startupLog.info("Custom tools registry initialized");

// Initialize Hermes client if configured
// biome-ignore lint/suspicious/noExplicitAny: config channels shape is dynamic
const hermesUrl = process.env.HERMES_URL ?? (config as any).channels?.hermesUrl;
if (hermesUrl) {
  // 平台清单是**部署配置值**（不是环境变量名）：包侧不读 process.env，由宿主在这里下发。
  initHermesClient(hermesUrl, { platforms: env.HERMES_PLATFORMS });
}

// Verify RagFlow connectivity (non-blocking — logs warning on failure)
const ragflowHealth = await checkRagFlowHealth();
if (ragflowHealth.ok) {
  console.log(`[startup] ${ragflowHealth.message}`);
} else {
  console.warn(`[startup] RagFlow health check failed: ${ragflowHealth.message}`);
}

// 定期巡检：将无活跃 WS 连接的 machine 标为 offline（处理服务重启、网络分区等场景）
startMachineSweep(60_000);
// file-ws 僵尸连接巡检（P0-1）：独立于 startMachineSweep——后者只查 DB 中 status=online
// 的机器（registry-heartbeat.ts），覆盖不到 file-ws 的 half-open 僵尸。默认关闭，
// 灰度防误杀旧机器端（keep_alive 缺失或间隔 >90s），开启时按配置间隔巡检。
if (config.fileWsSweepEnabled) {
  startFileWsSweep(config.fileWsSweepIntervalMs, config.fileWsIdleTimeoutMs);
}
agentRuntime.startIdleMonitor();

const app = new Elysia({
  websocket: {
    // file-ws 当前以单条 Base64 JSON 消息传输文件，单位由环境变量配置。
    maxPayloadLength: config.wsMaxPayloadMb * 1024 * 1024,
  },
})
  .use(corsPlugin)
  .use(createExternalOpenApiPlugin(config.version))
  .use(createWebOpenApiPlugin(config.version))
  .derive(deriveRequestId)
  .onBeforeHandle(logRequest)
  .onAfterHandle(logResponse)
  .onAfterHandle(injectRequestId)
  // ctrlStaticPlugin 必须在 errorPlugin 之前 use：其 onError（/ctrl/* SPA fallback）
  // 在链中先执行，命中时返回 index.html 终止链；errorPlugin 对所有错误返回 JSON
  // 响应，若在其后注册 SPA fallback 永远轮不到执行。
  .use(ctrlStaticPlugin)
  // 错误日志合并进 errorPlugin 内部处理（先映射 set.status 再写日志），
  // 不能挂在这里的 onError：errorPlugin 返回映射响应会终止 onError 链，
  // 且其前的 hook 读不到最终状态，日志会丢失或记录错误状态。
  .use(errorPlugin)
  // 全局请求体大小限制 100MB（文件上传、工作流任务等场景）
  .onBeforeHandle(({ request }) => {
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 100 * 1024 * 1024) {
      return new Response(
        JSON.stringify({
          error: {
            type: "PAYLOAD_TOO_LARGE",
            message: "Request body exceeds 100MB limit",
          },
        }),
        {
          status: 413,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  })
  // Path normalization: collapse double slashes
  .onBeforeHandle(({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.includes("//")) {
      url.pathname = url.pathname.replace(/\/+/g, "/");
      return new Response(null, {
        status: 302,
        headers: { Location: url.toString() },
      });
    }
  })
  // Health check
  .get("/health", () => ({ ...buildHealthInfo(startedAt), version: config.version }))
  .get(
    "/",
    ({ set }) => {
      set.status = 302;
      set.headers.Location = "/ctrl/";
    },
    {
      detail: {
        hide: true,
        summary: "根路径跳转到控制台",
        description: "服务根路径访问时统一重定向到 `/ctrl/` 控制台首页。该入口仅用于站点导航，默认不在公开文档中展示。",
      },
    },
  )
  // better-auth handler
  .use(authPlugin)
  // Web control panel routes
  .use(webApp)
  // Token-protected skill archive download for plugins/runtimes
  .use(skillDownloadRoutes)
  // Agent Sites L3 business frontend proxy (/web/site/deploy/:appId/* prefix)
  .use(createAgentSitesProxyRoutes({ authenticateRequest: authenticateSiteRequest }))
  // External API routes
  .use(createApiAgentsRoutes({ authGuardPlugin }))
  .use(createApiKnowledgeBaseRoutes({ authGuardPlugin }))
  .use(createApiSkillsRoutes({ authGuardPlugin }))
  .use(createApiModelsRoutes({ authGuardPlugin }))
  .use(createApiMcpRoutes({ authGuardPlugin }))
  .use(createApiSystemRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }))
  .use(createApiSystemLogsRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }))
  .use(createApiSystemModelGatewayRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }))
  .use(createApiSystemObserverRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }))
  .use(createApiSystemPeopleTreeRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }))
  .use(createApiSandboxRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }))
  .use(createApiSandboxClusterRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }))
  .use(createApiSandboxServerRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }))
  .use(createApiInstanceRoutes({ authGuardPlugin, logError }))
  .use(createApiWorkspaceRoutes({ authGuardPlugin }))
  .use(createApiWorkflowRoutes({ authGuardPlugin }))
  // OpenAI-compatible Chat API
  .use(createOpenaiChatRoutes({ authGuardPlugin }))
  // Workflow proxy (not under /web prefix)
  .use(createWorkflowStaticApp({ authGuardPlugin }))
  // MCP routes
  .use(knowledgeMcpRoutes)
  // ACP protocol routes
  .use(createAcpRoutes({ authGuardPlugin, authenticateRequest }))
  // Agent Sites 兼容层（兜底 /app-xxx/* 绝对路径访问，必须注册在最后）
  .use(createAgentSitesCompatRoutes({ authenticateRequest: authenticateSiteRequest }));

const port = config.port;
const host = config.host;

startupLog.info(`Listening on ${host}:${port} (baseUrl: ${config.baseUrl || `http://localhost:${port}`})`);

export type App = typeof app;

// app.listen() 设置 app.server（WebSocket 升级需要），同时 export default
// 供 Eden Treaty treaty<App>() 做类型推断
app.listen({
  port,
  hostname: host,
  // file-ws 载荷治理（§7.6，P1-11a）：Bun 默认 maxPayloadLength 为 16MB，uWS 层会先于
  // JS 层检查拒绝 16-32MB 的 file-ws 帧（20MB upload → ~27MB base64），32MB 上限形同虚设。
  // Bun 的 maxPayloadLength 是全局配置（Elysia 1.4.28 .ws() 路由级不透传，仅全局可设），
  // 放宽后 acp-ws / yjs / relay 仍由各自 JS 层 10MB 检查（MAX_WS_MESSAGE_SIZE）拦截：
  // 字符串/二进制帧按字节检查，object 帧（Elysia 默认 parse 产物）重序列化后检查
  // （src/routes/acp/index.ts isOverWsLimit），有效限制不变；file-ws 的 32MB 显式检查
  // 在 acp/index.ts 的 parse 钩子（解析前）+ uWS 全局上限（单行 JSON 帧路径）。
  websocket: {
    // Elysia 的 Partial<Serve> 类型要求完整 WebSocketHandler（message 必填），但运行时
    // 与 Elysia 自带消息分发器合并（adapter/bun 合并顺序 options 最后，仅补充字段）——
    // 若按类型补写 message 会覆盖分发器导致全部 WS 端点消息无法分发。第三方类型缺陷，
    // 最小范围断言规避，不引入其他字段。
    maxPayloadLength: env.RCS_FILE_WS_MAX_PAYLOAD_MB * 1024 * 1024,
  } as unknown as WebSocketHandler<unknown>,
});
export default app;

// Graceful shutdown
let gracefulShutdownPromise: Promise<void> | null = null;

const SHUTDOWN_DEADLINE_MS = 10_000;

function withShutdownDeadline<T>(promise: Promise<T>, phase: string, deadline: number): Promise<T | undefined> {
  const remaining = Math.max(0, deadline - Date.now());
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      setTimeout(() => {
        startupLog.error(`Shutdown phase timed out: ${phase}`);
        resolve(undefined);
      }, remaining).unref?.();
    }),
  ]);
}

function gracefulShutdown(signal: string): Promise<void> {
  if (gracefulShutdownPromise) return gracefulShutdownPromise;
  gracefulShutdownPromise = (async () => {
    const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
    startupLog.info(`Received ${signal}, shutting down...`);
    const runtimeDrain = agentRuntime.shutdown();
    schedulerService.stop();
    const hermesClient = getHermesClient();
    await withShutdownDeadline(hermesClient?.stop() ?? Promise.resolve(), "hermes", deadline);
    agentRuntime.stopIdleMonitor();
    agentRuntime.closeAllRelayConnections();
    agentRuntime.closeAllAcpConnections();
    // 先停巡检再关连接，避免巡检定时器与关闭流程并发操作同一索引
    stopFileWsSweep();
    closeAllFileWsConnections();
    await withShutdownDeadline(runtimeDrain, "runtimes", deadline);
    await withShutdownDeadline(closeCache(), "cache", deadline);
    await withShutdownDeadline(pgClient.end(), "database", deadline);
    process.exit(0);
  })();
  return gracefulShutdownPromise;
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
