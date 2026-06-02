import { execSync } from "node:child_process";
import swagger from "@elysiajs/swagger";
import Elysia from "elysia";
import { applyEnv, config } from "./config";
import { db, initDb, client as pgClient } from "./db";
import { agentSession } from "./db/schema";
import { validateEnv } from "./env";
import { authPlugin } from "./plugins/auth";
import { corsPlugin } from "./plugins/cors";
import { errorPlugin } from "./plugins/error-handler";
import { loggerPlugin } from "./plugins/logger";
import { rateLimitPlugin } from "./plugins/rate-limit";
import { ctrlStaticPlugin } from "./plugins/static";
import acpRoutes from "./routes/acp";
import knowledgeMcpRoutes from "./routes/mcp/knowledge";
import v2CodeSessions from "./routes/v2/code-sessions";
import sessionIngress from "./routes/v2/session-ingress";
import v2Worker from "./routes/v2/worker";
import v2WorkerEvents from "./routes/v2/worker-events";
import v2WorkerEventsStream from "./routes/v2/worker-events-stream";
import webApp from "./routes/web";
import { workflowStaticApp } from "./routes/web/workflow-proxy";
import { closeCache } from "./services/cache";
import { getCoreRuntime } from "./services/core-bootstrap";
import { getHermesClient, initHermesClient } from "./services/hermes-client";
import { stopAllInstances } from "./services/instance";
import { startScheduler, stopScheduler } from "./services/scheduler";
import { closeAllAcpConnections } from "./transport/acp-ws-handler";
import { closeAllRelayConnections } from "./transport/relay";

await initDb();
console.log("[RCS] Database initialized (PostgreSQL + better-auth)");

// 重启时重置所有 agent_session 状态为 idle
// WebSocket/EventBus 已断开，之前的运行状态不再有效
import { sql } from "drizzle-orm";

await db.update(agentSession).set({ status: "idle", updatedAt: new Date() }).where(sql`1=1`);
console.log("[RCS] All agent sessions reset to idle");

const env = validateEnv();
applyEnv(env);

getCoreRuntime();
console.log("[RCS] Core runtime initialized (opencode engine + local node)");

await startScheduler();

// Initialize Hermes client if configured
// biome-ignore lint/suspicious/noExplicitAny: config channels shape is dynamic
const hermesUrl = process.env.HERMES_URL ?? (config as any).channels?.hermesUrl;
if (hermesUrl) {
  initHermesClient(hermesUrl);
}

// Kill stale acp-link processes from previous runs
try {
  execSync("pkill -f 'acp-link.*opencode' || true", { stdio: "ignore" });
  console.log("[RCS] Cleaned up stale acp-link processes");
} catch {
  // pkill not available or no matching processes — ignore
}

// 定期巡检：将无活跃 WS 连接的 machine 标为 offline（处理服务重启、网络分区等场景）
import("./services/registry-heartbeat").then(({ startMachineSweep }) => {
  startMachineSweep(60_000);
});

const app = new Elysia()
  .use(corsPlugin)
  .use(
    swagger({
      documentation: {
        info: {
          title: "RCS API",
          version: config.version,
          description: "Remote Control Server API — config, sessions, environments, ACP protocol",
        },
        tags: [
          { name: "Config", description: "Configuration management (providers, models, agents, skills, MCP)" },
          { name: "Sessions", description: "Session management and event streaming" },
          { name: "Environments", description: "ACP agent environments" },
          { name: "Instances", description: "Agent instance lifecycle" },
          { name: "Tasks", description: "Scheduled HTTP tasks" },
          { name: "Knowledge", description: "Knowledge bases and resources" },
          { name: "Channels", description: "IM channel bindings" },
          { name: "Workflow Engine", description: "Native DAG workflow execution engine" },
        ],
      },
      swaggerOptions: {
        persistAuthorization: true,
      },
      exclude: ["/health", /^\/ctrl\/.*/],
      path: "/docs/swagger",
    }),
  )
  .use(loggerPlugin)
  .use(errorPlugin)
  .use(rateLimitPlugin)
  // 全局请求体大小限制 10MB
  .onBeforeHandle(({ request }) => {
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 10 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: { type: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 10MB limit" } }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      );
    }
  })
  // Path normalization: collapse double slashes
  .onBeforeHandle(({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.includes("//")) {
      url.pathname = url.pathname.replace(/\/+/g, "/");
      return new Response(null, { status: 302, headers: { Location: url.toString() } });
    }
  })
  // Health check
  .get("/health", () => ({ status: "ok", version: config.version }))
  .get("/", ({ set }) => {
    set.status = 302;
    set.headers.Location = "/ctrl/";
  })
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
  // Workflow proxy (not under /web prefix)
  .use(workflowStaticApp)
  // MCP routes
  .use(knowledgeMcpRoutes)
  // ACP protocol routes
  .use(acpRoutes);

console.log("[RCS] ACP support enabled");

const port = config.port;
const host = config.host;

console.log(`[RCS] Remote Control Server starting on ${host}:${port}`);
console.log(`[RCS] Base URL: ${config.baseUrl || `http://localhost:${port}`}`);
console.log(`[RCS] WebSocket idle timeout: ${config.wsIdleTimeout}s`);
console.log(`[RCS] WebSocket keepalive interval: ${config.wsKeepaliveInterval}s`);

export type App = typeof app;

// app.listen() 设置 app.server（WebSocket 升级需要），同时 export default
// 供 Eden Treaty treaty<App>() 做类型推断
app.listen({ port, hostname: host });
export default app;

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n[RCS] Received ${signal}, shutting down...`);
  const hermesClient = getHermesClient();
  await hermesClient?.stop();
  closeAllRelayConnections();
  closeAllAcpConnections();
  await stopAllInstances();
  stopScheduler();
  await closeCache();
  await pgClient.end();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
