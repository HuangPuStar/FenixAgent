import { createLogger, interceptConsole } from "@fenix/logger";

// ⚠️ 必须在所有其他代码之前拦截 console，保证全局日志统一
interceptConsole();

const startupLog = createLogger("rcs");

import type { WebSocketHandler } from "bun";
import Elysia from "elysia";
import { applyEnv, config } from "../../../src/config";
import { initDb, client as pgClient } from "../../../src/db";
import { findDeprecatedEnvVars } from "../../../src/env";
import { createExternalOpenApiPlugin, createWebOpenApiPlugin } from "../../../src/openapi";
import { authPlugin } from "../../../src/plugins/auth";
import { corsPlugin } from "../../../src/plugins/cors";
import { errorPlugin } from "../../../src/plugins/error-handler";
import { deriveRequestId, injectRequestId, logRequest, logResponse } from "../../../src/plugins/logger";
import { ctrlStaticPlugin } from "../../../src/plugins/static";
import acpRoutes from "../../../src/routes/acp";
import { agentSitesCompatApp, agentSitesProxyApp } from "../../../src/routes/agent-sites-proxy";
import apiAgentsRoutes from "../../../src/routes/api/agents";
import apiInstanceRoutes from "../../../src/routes/api/instances";
import apiKnowledgeBaseRoutes from "../../../src/routes/api/knowledge-bases";
import apiMcpRoutes from "../../../src/routes/api/mcp";
import apiModelsRoutes from "../../../src/routes/api/models";
import openaiChatRoutes from "../../../src/routes/api/openai-chat";
import apiSandboxRoutes from "../../../src/routes/api/sandbox";
import apiSandboxClusterRoutes from "../../../src/routes/api/sandbox-cluster";
import apiSandboxServerRoutes from "../../../src/routes/api/sandbox-server";
import apiSkillsRoutes from "../../../src/routes/api/skills";
import apiSystemRoutes from "../../../src/routes/api/system";
import apiSystemLogsRoutes from "../../../src/routes/api/system-logs";
import apiSystemModelGatewayRoutes from "../../../src/routes/api/system-model-gateway";
import apiSystemObserverRoutes from "../../../src/routes/api/system-observer";
import apiSystemPeopleTreeRoutes from "../../../src/routes/api/system-people-tree";
import apiWorkflowRoutes from "../../../src/routes/api/workflows";
import apiWorkspaceRoutes from "../../../src/routes/api/workspaces";
import knowledgeMcpRoutes from "../../../src/routes/mcp/knowledge";
import skillDownloadRoutes from "../../../src/routes/skills";
import webApp from "../../../src/routes/web";
import { workflowStaticApp } from "../../../src/routes/web/workflow-proxy";
import { startAcpIdleMonitor, stopAcpIdleMonitor } from "../../../src/services/acp-idle-monitor";
import { agentInstanceService } from "../../../src/services/agent-instance-service";
import { buildHealthInfo } from "../../../src/services/build-info";
import { closeCache } from "../../../src/services/cache";
import { initCoreRuntime } from "../../../src/services/core-bootstrap";
import { runDataMigrations } from "../../../src/services/data-migrate";
import { getHermesClient, initHermesClient } from "../../../src/services/hermes-client";
import { checkRagFlowHealth } from "../../../src/services/knowledge-provider/ragflow";
import { setRuntimeCredentialResolver } from "../../../src/services/launch-spec-builder";
import { createSystemModelGatewayProviderService } from "../../../src/services/model-gateway/provider-service";
import { createModelGatewayRuntime } from "../../../src/services/model-gateway/runtime";
import { registerConfiguredSandboxProviders, sandboxManager } from "../../../src/services/sandbox";
import { initializeDefaultSandboxPool } from "../../../src/services/sandbox/sandbox-default-pool";
import { schedulerService } from "../../../src/services/scheduler/index";
import { syncBuiltin } from "../../../src/services/sync-builtin";
import { ensureSystemAdmin } from "../../../src/services/system-admin";
import { initCustomToolsRegistry } from "../../../src/services/workflow/custom-tools";
import { closeAllAcpConnections } from "../../../src/transport/acp-ws-handler";
import { closeAllFileWsConnections, stopFileWsSweep } from "../../../src/transport/file-ws-handler";
import { closeAllRelayConnections } from "../../../src/transport/relay";
import { loadServerEnv } from "./env-loader";

const startedAt = new Date().toISOString();

const env = loadServerEnv([]);
applyEnv(env);
await initDb();
startupLog.info("Database initialized");

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
import("../../../src/services/registry-heartbeat").then(({ startMachineSweep }) => {
  startMachineSweep(60_000);
});
// file-ws 僵尸连接巡检（P0-1）：独立于 startMachineSweep——后者只查 DB 中 status=online
// 的机器（registry-heartbeat.ts），覆盖不到 file-ws 的 half-open 僵尸。默认关闭，
// 灰度防误杀旧机器端（keep_alive 缺失或间隔 >90s），开启时按配置间隔巡检。
if (config.fileWsSweepEnabled) {
  import("../../../src/transport/file-ws-handler").then(({ startFileWsSweep }) => {
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
    const runtimeDrain = agentInstanceService.shutdownRuntimes();
    schedulerService.stop();
    const hermesClient = getHermesClient();
    await withShutdownDeadline(hermesClient?.stop() ?? Promise.resolve(), "hermes", deadline);
    stopAcpIdleMonitor();
    closeAllRelayConnections();
    closeAllAcpConnections();
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
