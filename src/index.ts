import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import swagger from "@elysiajs/swagger";
import Elysia from "elysia";
import { applyEnv, config } from "./config";
import { initDb, client as pgClient } from "./db";
import { validateEnv } from "./env";
import { authGuardPlugin, authPlugin } from "./plugins/auth";
import { corsPlugin } from "./plugins/cors";
import { errorPlugin } from "./plugins/error-handler";
import { loggerPlugin } from "./plugins/logger";
import { rateLimitPlugin } from "./plugins/rate-limit";
import { ctrlStaticPlugin } from "./plugins/static";
import { environmentRepo } from "./repositories";
import acpRoutes from "./routes/acp";
import knowledgeMcpRoutes from "./routes/mcp/knowledge";
import v1Environments from "./routes/v1/environments";
import v1EnvironmentsWork from "./routes/v1/environments.work";
import v1SessionIngress from "./routes/v1/session-ingress";
import v1Sessions from "./routes/v1/sessions";
import v2CodeSessions from "./routes/v2/code-sessions";
import v2Worker from "./routes/v2/worker";
import v2WorkerEvents from "./routes/v2/worker-events";
import v2WorkerEventsStream from "./routes/v2/worker-events-stream";
import webAuth from "./routes/web/auth";
import webChannels from "./routes/web/channels";
import webConfig from "./routes/web/config";
import webControl from "./routes/web/control";
import webEnvironments from "./routes/web/environments";
import webFiles from "./routes/web/files";
import webUserFile from "./routes/web/user-file";
import webInstances from "./routes/web/instances";
import webKnowledgeBases from "./routes/web/knowledge-bases";
import webOrganizations from "./routes/web/organizations";
import webS3Files from "./routes/web/s3-files";
import webSessions from "./routes/web/sessions";
import webSkills from "./routes/web/skills";
import webTasks from "./routes/web/tasks";
import webMetaAgent from "./routes/web/meta-agent";
import webWorkflowDefs from "./routes/web/workflow-defs";
import webWorkflowEngine from "./routes/web/workflow-engine";
import { workflowStaticApp } from "./routes/web/workflow-proxy";
import { getCoreRuntime } from "./services/core-bootstrap";
import { getHermesClient, initHermesClient } from "./services/hermes-client";
import { findRunningInstanceByEnvironment, spawnInstanceFromEnvironment, stopAllInstances } from "./services/instance";
import { startScheduler, stopScheduler } from "./services/scheduler";
import { closeAllRelayConnections } from "./transport/relay";
import { closeAllAcpConnections } from "./transport/acp-ws-handler";
import { closeCache } from "./services/cache";
import { resolveWorkspacePath } from "./services/workspace-resolver";

await initDb();
console.log("[RCS] Database initialized (PostgreSQL + better-auth)");

const env = validateEnv();
applyEnv(env);

getCoreRuntime();
console.log("[RCS] Core runtime initialized (opencode engine + local node)");

await startScheduler();

// Initialize Hermes client if configured
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

// Auto-start instances for all environments on server boot
(async () => {
  const envs = await environmentRepo.listAll();
  for (const env of envs) {
    if (!env.userId) continue;
    if (!env.organizationId) continue;
    if (!env.autoStart) continue;
    const cwd = resolveWorkspacePath(env.organizationId, env.userId);
    if (!existsSync(cwd)) {
      console.log(`[RCS] Skipping environment ${env.name}: workspace directory does not exist (${cwd})`);
      continue;
    }
    const existing = findRunningInstanceByEnvironment(env.id);
    if (existing) continue;
    try {
      await spawnInstanceFromEnvironment(env.userId, env.id);
      console.log(`[RCS] Auto-started instance for environment: ${env.name} (${env.id})`);
    } catch (err: any) {
      console.error(`[RCS] Failed to auto-start instance for ${env.name}: ${err.message}`);
    }
  }
})();

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
    if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
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
  // v1 compatibility routes
  .use(v1Environments)
  .use(v1EnvironmentsWork)
  .use(v1Sessions)
  .use(v1SessionIngress)
  // v2 routes
  .use(v2CodeSessions)
  .use(v2Worker)
  .use(v2WorkerEvents)
  .use(v2WorkerEventsStream)
  // Web control panel routes
  .use(webSessions)
  .use(webEnvironments)
  .use(webOrganizations)
  .use(webConfig)
  .use(webSkills)
  .use(webInstances)
  .use(webTasks)
  .use(webChannels)
  .use(webKnowledgeBases)
  .use(webFiles)
  .use(webUserFile)
  .use(webS3Files)
  .use(webControl)
  .use(webAuth)
  // Workflow proxy
  .use(workflowStaticApp)
  // Workflow engine API
  .use(webWorkflowEngine)
  // Workflow definition API
  .use(webWorkflowDefs)
  // Meta Agent API
  .use(webMetaAgent)
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
  closeAllAcpConnections();
  closeAllRelayConnections();
  await stopAllInstances();
  stopScheduler();
  await closeCache();
  await pgClient.end();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
