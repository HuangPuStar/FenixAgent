import { createLogger, interceptConsole } from "@fenix/logger";

// ⚠️ 必须在所有其他代码之前拦截 console，保证全局日志统一
interceptConsole();

const startupLog = createLogger("rcs");

import type { WebSocketHandler } from "bun";
import Elysia from "elysia";
import { applyEnv, config } from "./config";
import { initDb, client as pgClient } from "./db";
import { findDeprecatedEnvVars, validateEnv } from "./env";
import { createExternalOpenApiPlugin, createWebOpenApiPlugin } from "./openapi";
import { authPlugin } from "./plugins/auth";
import { corsPlugin } from "./plugins/cors";
import { errorPlugin } from "./plugins/error-handler";
import { deriveRequestId, injectRequestId, logRequest, logResponse } from "./plugins/logger";
import { ctrlStaticPlugin } from "./plugins/static";
import acpRoutes from "./routes/acp";
import { agentSitesCompatApp, agentSitesProxyApp } from "./routes/agent-sites-proxy";
import apiAgentsRoutes from "./routes/api/agents";
import apiInstanceRoutes from "./routes/api/instances";
import apiKnowledgeBaseRoutes from "./routes/api/knowledge-bases";
import apiMcpRoutes from "./routes/api/mcp";
import apiModelsRoutes from "./routes/api/models";
import openaiChatRoutes from "./routes/api/openai-chat";
import apiSandboxRoutes from "./routes/api/sandbox";
import apiSandboxClusterRoutes from "./routes/api/sandbox-cluster";
import apiSandboxServerRoutes from "./routes/api/sandbox-server";
import apiSkillsRoutes from "./routes/api/skills";
import apiSystemRoutes from "./routes/api/system";
import apiSystemLogsRoutes from "./routes/api/system-logs";
import apiSystemModelGatewayRoutes from "./routes/api/system-model-gateway";
import apiSystemObserverRoutes from "./routes/api/system-observer";
import apiSystemPeopleTreeRoutes from "./routes/api/system-people-tree";
import apiWorkflowRoutes from "./routes/api/workflows";
import apiWorkspaceRoutes from "./routes/api/workspaces";
import knowledgeMcpRoutes from "./routes/mcp/knowledge";
import skillDownloadRoutes from "./routes/skills";
import webApp from "./routes/web";
import { workflowStaticApp } from "./routes/web/workflow-proxy";
import { startAcpIdleMonitor, stopAcpIdleMonitor } from "./services/acp-idle-monitor";
import { buildHealthInfo } from "./services/build-info";
import { closeCache } from "./services/cache";
import { initCoreRuntime } from "./services/core-bootstrap";
import { runDataMigrations } from "./services/data-migrate";
import { getHermesClient, initHermesClient } from "./services/hermes-client";
import { stopAllInstances } from "./services/instance";
import { checkRagFlowHealth } from "./services/knowledge-provider/ragflow";
import { setRuntimeCredentialResolver } from "./services/launch-spec-builder";
import { createSystemModelGatewayProviderService } from "./services/model-gateway/provider-service";
import { createModelGatewayRuntime } from "./services/model-gateway/runtime";
import { registerConfiguredSandboxProviders, sandboxManager } from "./services/sandbox";
import { initializeDefaultSandboxPool } from "./services/sandbox/sandbox-default-pool";
import { schedulerService } from "./services/scheduler/index";
import { syncBuiltin } from "./services/sync-builtin";
import { ensureSystemAdmin } from "./services/system-admin";
import { initCustomToolsRegistry } from "./services/workflow/custom-tools";
import { closeAllAcpConnections } from "./transport/acp-ws-handler";
import { closeAllFileWsConnections, stopFileWsSweep } from "./transport/file-ws-handler";
import { closeAllRelayConnections } from "./transport/relay";

const startedAt = new Date().toISOString();

await initDb();
startupLog.info("Database initialized");

const env = validateEnv();
applyEnv(env);
registerConfiguredSandboxProviders();

// 废弃环境变量启动告警：RCS_DEFAULT_MACHINE_TYPE 是 637a4cef 引入的死配置，服务端从未读取，
// 且 c71ee18c 后 ENGINE_TYPE 仅对 local 执行生效（远程引擎由机器端 AGENT_TYPE 唯一控制）。
// 部署侧配置了旧变量时显式提示，避免死配置被 zod strip 静默丢弃。
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

const modelGatewayRuntime = createModelGatewayRuntime();
if (modelGatewayRuntime) {
  await modelGatewayRuntime.services.provider.ensureProvider();
  setRuntimeCredentialResolver(modelGatewayRuntime.resolveRuntimeCredential);
  modelGatewayRuntime.reconcile.start();
  startupLog.info("Model gateway runtime initialized");
} else {
  // Provider 投影即使未配置管理凭证也需要存在，便于管理端显示待配置状态。
  await createSystemModelGatewayProviderService(
    {},
    {
      baseUrl: config.modelGatewayPublicBaseUrl,
      gatewayType: config.modelGatewayType,
    },
  ).ensureProvider();
}

// 沙盒默认池初始化与崩溃恢复（Sandbox 能力，早于 core runtime 启动）。
// 失败不阻断启动：沙盒不可用时仅影响沙盒执行节点，普通执行路径不受影响。
try {
  const defaultPool = await initializeDefaultSandboxPool(config);
  if (defaultPool) startupLog.info(`Default sandbox pool initialized: ${defaultPool.id}`);
} catch (error) {
  startupLog.error("Failed to initialize default sandbox pool", error instanceof Error ? error : undefined);
}

await sandboxManager.recoverAfterRestart();

await initCoreRuntime();
startupLog.info("Core runtime initialized");

await schedulerService.start();

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
  initHermesClient(hermesUrl);
}

// Verify RagFlow connectivity (non-blocking — logs warning on failure)
const ragflowHealth = await checkRagFlowHealth();
if (ragflowHealth.ok) {
  console.log(`[startup] ${ragflowHealth.message}`);
} else {
  console.warn(`[startup] RagFlow health check failed: ${ragflowHealth.message}`);
}

// 定期巡检：将无活跃 WS 连接的 machine 标为 offline（处理服务重启、网络分区等场景）
import("./services/registry-heartbeat").then(({ startMachineSweep }) => {
  startMachineSweep(60_000);
});
// file-ws 僵尸连接巡检（P0-1）：独立于 startMachineSweep——后者只查 DB 中 status=online
// 的机器（registry-heartbeat.ts），覆盖不到 file-ws 的 half-open 僵尸。默认关闭，
// 灰度防误杀旧机器端（keep_alive 缺失或间隔 >90s），开启时按配置间隔巡检。
if (config.fileWsSweepEnabled) {
  import("./transport/file-ws-handler").then(({ startFileWsSweep }) => {
    startFileWsSweep(config.fileWsSweepIntervalMs, config.fileWsIdleTimeoutMs);
  });
}
startAcpIdleMonitor();

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
  .onAfterResponse(logResponse)
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
  .use(agentSitesProxyApp)
  // External API routes
  .use(apiAgentsRoutes)
  .use(apiKnowledgeBaseRoutes)
  .use(apiSkillsRoutes)
  .use(apiModelsRoutes)
  .use(apiMcpRoutes)
  .use(apiSystemRoutes)
  .use(apiSystemLogsRoutes)
  .use(apiSystemModelGatewayRoutes)
  .use(apiSystemObserverRoutes)
  .use(apiSystemPeopleTreeRoutes)
  .use(apiSandboxRoutes)
  .use(apiSandboxClusterRoutes)
  .use(apiSandboxServerRoutes)
  .use(apiInstanceRoutes)
  .use(apiWorkspaceRoutes)
  .use(apiWorkflowRoutes)
  // OpenAI-compatible Chat API
  .use(openaiChatRoutes)
  // Workflow proxy (not under /web prefix)
  .use(workflowStaticApp)
  // MCP routes
  .use(knowledgeMcpRoutes)
  // ACP protocol routes
  .use(acpRoutes)
  // Agent Sites 兼容层（兜底 /app-xxx/* 绝对路径访问，必须注册在最后）
  .use(agentSitesCompatApp);

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
async function gracefulShutdown(signal: string) {
  startupLog.info(`Received ${signal}, shutting down...`);
  const hermesClient = getHermesClient();
  await hermesClient?.stop();
  stopAcpIdleMonitor();
  closeAllRelayConnections();
  closeAllAcpConnections();
  // 先停巡检再关连接，避免巡检定时器与关闭流程并发操作同一索引
  stopFileWsSweep();
  closeAllFileWsConnections();
  await stopAllInstances();
  schedulerService.stop();
  modelGatewayRuntime?.reconcile.stop();
  await closeCache();
  await pgClient.end();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
