import Elysia from "elysia";
import { config } from "./config";
import { initDb, client as pgClient } from "./db";
import { closeAllAcpConnections } from "./transport/acp-ws-handler";
import { closeAllRelayConnections } from "./transport/acp-relay-handler";
import { existsSync } from "node:fs";
import acpRoutes from "./routes/acp";
import v1Environments from "./routes/v1/environments";
import v1EnvironmentsWork from "./routes/v1/environments.work";
import v1Sessions from "./routes/v1/sessions";
import v1SessionIngress from "./routes/v1/session-ingress";
import v2CodeSessions from "./routes/v2/code-sessions";
import v2Worker from "./routes/v2/worker";
import v2WorkerEvents from "./routes/v2/worker-events";
import v2WorkerEventsStream from "./routes/v2/worker-events-stream";
import webSessions from "./routes/web/sessions";
import webEnvironments from "./routes/web/environments";
import webApiKeys from "./routes/web/api-keys";
import webConfig from "./routes/web/config";
import webInstances from "./routes/web/instances";
import webTasks from "./routes/web/tasks";
import webChannels from "./routes/web/channels";
import webKnowledgeBases from "./routes/web/knowledge-bases";
import webFiles from "./routes/web/files";
import webS3Files from "./routes/web/s3-files";
import webControl from "./routes/web/control";
import webAuth from "./routes/web/auth";
import { workflowStaticApp } from "./routes/web/workflow-proxy";
import knowledgeMcpRoutes from "./routes/mcp/knowledge";
import { stopAllInstances, spawnInstanceFromEnvironment, findRunningInstanceByEnvironment } from "./services/instance";
import { getCoreRuntime } from "./services/core-bootstrap";
import { environmentRepo } from "./repositories";
import { repoPlugin } from "./plugins/repositories";
import { migrateSkillsDir } from "./services/skill";
import { startScheduler, stopScheduler } from "./services/scheduler";
import { initHermesClient, getHermesClient } from "./services/hermes-client";
import { execSync } from "node:child_process";
import { corsPlugin } from "./plugins/cors";
import { loggerPlugin } from "./plugins/logger";
import { errorPlugin } from "./plugins/error-handler";
import { authPlugin, authGuardPlugin } from "./plugins/auth";
import { ctrlStaticPlugin } from "./plugins/static";

await initDb();
console.log("[RCS] Database initialized (PostgreSQL + better-auth)");

getCoreRuntime();
console.log("[RCS] Core runtime initialized (opencode engine + local node)");

await migrateSkillsDir();
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
    if (!env.autoStart) continue;
    const cwd = env.workspacePath || env.directory;
    if (!cwd || !existsSync(cwd)) {
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
  .use(loggerPlugin)
  .use(errorPlugin)
  .use(repoPlugin)
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
  .get("/", ({ set }) => { set.status = 302; set.headers.Location = "/ctrl/"; })
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
  .use(webApiKeys)
  .use(webConfig)
  .use(webInstances)
  .use(webTasks)
  .use(webChannels)
  .use(webKnowledgeBases)
  .use(webFiles)
  .use(webS3Files)
  .use(webControl)
  .use(webAuth)
  // Workflow proxy
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

export default {
  port,
  hostname: host,
  fetch: app.fetch,
};

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n[RCS] Received ${signal}, shutting down...`);
  const hermesClient = getHermesClient();
  await hermesClient?.stop();
  closeAllAcpConnections();
  closeAllRelayConnections();
  await stopAllInstances();
  stopScheduler();
  await pgClient.end();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
