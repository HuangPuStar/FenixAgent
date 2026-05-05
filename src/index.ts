import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { websocket } from "hono/bun";
import { config } from "./config";
import { auth } from "./auth/better-auth";
import { closeAllAcpConnections } from "./transport/acp-ws-handler";
import { closeAllRelayConnections } from "./transport/acp-relay-handler";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import acpRoutes from "./routes/acp";
import v1Environments from "./routes/v1/environments";
import webSessions from "./routes/web/sessions";
import webEnvironments from "./routes/web/environments";
import webApiKeys from "./routes/web/api-keys";
import webConfig from "./routes/web/config";
import webInstances from "./routes/web/instances";
import webTasks from "./routes/web/tasks";
import webChannels from "./routes/web/channels";
import fileRoutes from "./routes/web/files";
import { workflowStaticApp, workflowApiApp } from "./routes/web/workflow-proxy";
import { stopAllInstances, spawnInstanceFromEnvironment, findRunningInstanceByEnvironment } from "./services/instance";
import { storeListAllEnvironments } from "./store";
import { migrateSkillsDir } from "./services/skill";
import { startScheduler, stopScheduler } from "./services/scheduler";
import { execSync } from "node:child_process";

console.log("[RCS] Database initialized (SQLite + better-auth)");

await migrateSkillsDir();
await startScheduler();

// Kill stale acp-link processes from previous runs
try {
  execSync("pkill -f 'acp-link.*opencode' || true", { stdio: "ignore" });
  console.log("[RCS] Cleaned up stale acp-link processes");
} catch {
  // pkill not available or no matching processes — ignore
}

// Auto-start instances for all environments on server boot
(async () => {
  const envs = storeListAllEnvironments();
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

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path.includes("//")) {
    const normalized = path.replace(/\/+/g, "/");
    const url = new URL(c.req.url);
    url.pathname = normalized;
    return app.fetch(new Request(url.toString(), c.req.raw));
  }
  await next();
});
app.use("/web/*", cors());
app.use("/api/auth/*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

// Health check
app.get("/health", (c) => c.json({ status: "ok", version: config.version }));
app.get("/", (c) => c.redirect("/ctrl/"));

// better-auth handler
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Static files — serve built web UI under /ctrl path
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "../web/dist");
const webDir = existsSync(resolve(distDir, "index.html")) ? distDir : resolve(__dirname, "../web");

const stripCtrlPrefix = (p: string) => p.replace(/^\/ctrl/, "");

// /ctrl/:sessionId/user/* → redirect to file preview API (for iframe embedding)
app.get("/ctrl/:sessionId/user/:filePath{.+}", (c) => {
  const sessionId = c.req.param("sessionId");
  const filePath = c.req.param("filePath");
  return c.redirect(`/web/sessions/${sessionId}/user/${filePath}?preview=true`);
});

app.use("/ctrl/*", serveStatic({ root: webDir, rewriteRequestPath: stripCtrlPrefix }));
app.get("/ctrl", serveStatic({ root: webDir, path: "index.html" }));
app.get("/ctrl/", serveStatic({ root: webDir, path: "index.html" }));
app.get("/ctrl/:sessionId", serveStatic({ root: webDir, path: "index.html" }));
app.get("/ctrl/:sessionId/", serveStatic({ root: webDir, path: "index.html" }));

// v1 compatibility routes (acp-link REST registration)
app.route("/v1/environments", v1Environments);

// Web control panel routes
app.route("/web/sessions", fileRoutes);
app.route("/web", webSessions);
app.route("/web", webEnvironments);
app.route("/web", webApiKeys);
app.route("/web", webConfig);
app.route("/web", webInstances);
app.route("/web", webTasks);
app.route("/web", webChannels);

// Workflow proxy routes (forward to acpx-g)
app.route("/workflow-ui", workflowStaticApp);
app.route("/api/v1", workflowApiApp);

// ACP protocol routes
console.log("[RCS] ACP support enabled");
app.route("/acp", acpRoutes);

const port = config.port;
const host = config.host;

console.log(`[RCS] Remote Control Server starting on ${host}:${port}`);
console.log(`[RCS] Base URL: ${config.baseUrl || `http://localhost:${port}`}`);
console.log(`[RCS] WebSocket idle timeout: ${config.wsIdleTimeout}s`);
console.log(`[RCS] WebSocket keepalive interval: ${config.wsKeepaliveInterval}s`);

export default {
  port,
  hostname: host,
  fetch: app.fetch,
  websocket: {
    ...websocket,
    idleTimeout: config.wsIdleTimeout,
  },
  idleTimeout: config.wsIdleTimeout,
};

// Graceful shutdown
async function gracefulShutdown(signal: string) {
  console.log(`\n[RCS] Received ${signal}, shutting down...`);
  closeAllAcpConnections();
  closeAllRelayConnections();
  stopAllInstances();
  stopScheduler();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
