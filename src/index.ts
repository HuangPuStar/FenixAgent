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
import { migrateSkillsDir } from "./services/skill";

console.log("[RCS] Database initialized (SQLite + better-auth)");

await migrateSkillsDir();

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

// better-auth handler
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Static files — serve built web UI under /code path
const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "../web/dist");
const webDir = existsSync(resolve(distDir, "index.html")) ? distDir : resolve(__dirname, "../web");

const stripCodePrefix = (p: string) => p.replace(/^\/code/, "");

app.use("/code/*", serveStatic({ root: webDir, rewriteRequestPath: stripCodePrefix }));
app.get("/code", serveStatic({ root: webDir, path: "index.html" }));
app.get("/code/", serveStatic({ root: webDir, path: "index.html" }));
app.get("/code/:sessionId", serveStatic({ root: webDir, path: "index.html" }));

// v1 compatibility routes (acp-link REST registration)
app.route("/v1/environments", v1Environments);

// Web control panel routes
app.route("/web", webSessions);
app.route("/web", webEnvironments);
app.route("/web", webApiKeys);
app.route("/web", webConfig);

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
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
