import { createLogger, interceptConsole } from "@fenix/logger";

// ⚠️ 必须在所有其他代码之前拦截 console，保证全局日志统一
interceptConsole();

const startupLog = createLogger("rcs");

import { execSync } from "node:child_process";
import Elysia from "elysia";
import { applyEnv, config } from "./config";
import { db, initDb, client as pgClient } from "./db";
import { agentSession } from "./db/schema";
import { validateEnv } from "./env";
import { createExternalOpenApiPlugin, createWebOpenApiPlugin } from "./openapi";
import { authPlugin } from "./plugins/auth";
import { corsPlugin } from "./plugins/cors";
import { errorPlugin } from "./plugins/error-handler";
import { deriveRequestId, injectRequestId, logError, logRequest, logResponse } from "./plugins/logger";
import { rateLimitPlugin } from "./plugins/rate-limit";
import { ctrlStaticPlugin } from "./plugins/static";
import acpRoutes from "./routes/acp";
import agentSitesProxyApp from "./routes/agent-sites-proxy";
import apiAgentsRoutes from "./routes/api/agents";
import apiInstanceRoutes from "./routes/api/instances";
import apiKnowledgeBaseRoutes from "./routes/api/knowledge-bases";
import apiMcpRoutes from "./routes/api/mcp";
import apiModelsRoutes from "./routes/api/models";
import apiSkillsRoutes from "./routes/api/skills";
import apiSystemRoutes from "./routes/api/system";
import apiWorkspaceRoutes from "./routes/api/workspaces";
import knowledgeMcpRoutes from "./routes/mcp/knowledge";
import v2CodeSessions from "./routes/v2/code-sessions";
import sessionIngress from "./routes/v2/session-ingress";
import v2Worker from "./routes/v2/worker";
import v2WorkerEvents from "./routes/v2/worker-events";
import v2WorkerEventsStream from "./routes/v2/worker-events-stream";
import webApp from "./routes/web";
import { workflowStaticApp } from "./routes/web/workflow-proxy";
import { startAcpIdleMonitor, stopAcpIdleMonitor } from "./services/acp-idle-monitor";
import { closeCache } from "./services/cache";
import { getCoreRuntime } from "./services/core-bootstrap";
import { runDataMigrations } from "./services/data-migrate";
import { getHermesClient, initHermesClient } from "./services/hermes-client";
import { stopAllInstances } from "./services/instance";
import { checkRagFlowHealth } from "./services/knowledge-provider/ragflow";
import { startScheduler, stopScheduler } from "./services/scheduler";
import { syncBuiltin } from "./services/sync-builtin";
import { ensureSystemAdmin } from "./services/system-admin";
import { initCustomToolsRegistry } from "./services/workflow/custom-tools";
import { closeAllAcpConnections } from "./transport/acp-ws-handler";
import { closeAllFileWsConnections } from "./transport/file-ws-handler";
import { closeAllRelayConnections } from "./transport/relay";

await initDb();
startupLog.info("Database initialized");

const env = validateEnv();
applyEnv(env);

// 先应用 env，再跑系统初始化：system admin 需要读取密码文件路径配置。
const systemAdmin = await ensureSystemAdmin();
startupLog.info(`System admin ready: ${systemAdmin.email}`);

// 数据迁移仍要早于 builtin 同步，避免旧数据结构影响系统资源落盘位置。
await runDataMigrations();
startupLog.info("Data migrations completed");

// 重启时重置所有 agent_session 状态为 idle
// WebSocket/EventBus 已断开，之前的运行状态不再有效
import { sql } from "drizzle-orm";

await db.update(agentSession).set({ status: "idle", updatedAt: new Date() }).where(sql`1=1`);

getCoreRuntime();
startupLog.info("Core runtime initialized");

await startScheduler();

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

// Kill stale acp-link processes from previous runs
try {
  execSync("pkill -f 'acp-link' || true", { stdio: "ignore" });
} catch {
  // pkill not available or no matching processes — ignore
}

// 定期巡检：将无活跃 WS 连接的 machine 标为 offline（处理服务重启、网络分区等场景）
import("./services/registry-heartbeat").then(({ startMachineSweep }) => {
  startMachineSweep(60_000);
});
startAcpIdleMonitor();

const app = new Elysia()
  .use(corsPlugin)
  .use(createExternalOpenApiPlugin(config.version))
  .use(createWebOpenApiPlugin(config.version))
  .derive(deriveRequestId)
  .onBeforeHandle(logRequest)
  .onAfterHandle(logResponse)
  .onAfterHandle(injectRequestId)
  .onError(({ request, error, set }) => logError({ request, error, set }))
  .use(errorPlugin)
  .use(rateLimitPlugin)
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
  .get("/health", () => ({ status: "ok", version: config.version }))
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
  // Static files under /ctrl
  .use(ctrlStaticPlugin)
  // v2 routes
  .use(v2CodeSessions)
  .use(sessionIngress)
  .use(v2Worker)
  .use(v2WorkerEvents)
  .use(v2WorkerEventsStream)
  // Web control panel routes
  .use(webApp)
  // Agent Sites L3 business frontend proxy (/{appId}/* prefix)
  .use(agentSitesProxyApp)
  // External API routes
  .use(apiAgentsRoutes)
  .use(apiKnowledgeBaseRoutes)
  .use(apiSkillsRoutes)
  .use(apiModelsRoutes)
  .use(apiMcpRoutes)
  .use(apiSystemRoutes)
  .use(apiInstanceRoutes)
  .use(apiWorkspaceRoutes)
  // Workflow proxy (not under /web prefix)
  .use(workflowStaticApp)
  // MCP routes
  .use(knowledgeMcpRoutes)
  // ACP protocol routes
  .use(acpRoutes);

const port = config.port;
const host = config.host;

startupLog.info(`Listening on ${host}:${port} (baseUrl: ${config.baseUrl || `http://localhost:${port}`})`);

export type App = typeof app;

// app.listen() 设置 app.server（WebSocket 升级需要），同时 export default
// 供 Eden Treaty treaty<App>() 做类型推断
app.listen({ port, hostname: host });
export default app;

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  startupLog.info(`Received ${signal}, shutting down...`);
  const hermesClient = getHermesClient();
  await hermesClient?.stop();
  stopAcpIdleMonitor();
  closeAllRelayConnections();
  closeAllAcpConnections();
  closeAllFileWsConnections();
  await stopAllInstances();
  stopScheduler();
  await closeCache();
  await pgClient.end();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
