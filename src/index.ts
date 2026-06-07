import { createLogger, interceptConsole } from "@fenix/logger";

// ⚠️ 必须在所有其他代码之前拦截 console，保证全局日志统一
interceptConsole();

const startupLog = createLogger("rcs");

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import swagger from "@elysiajs/swagger";
import Elysia from "elysia";
import { applyEnv, config } from "./config";
import { db, initDb, client as pgClient } from "./db";
import { agentSession, member } from "./db/schema";
import { validateEnv } from "./env";
import { authPlugin } from "./plugins/auth";
import { corsPlugin } from "./plugins/cors";
import { errorPlugin } from "./plugins/error-handler";
import { loggerPlugin } from "./plugins/logger";
import { rateLimitPlugin } from "./plugins/rate-limit";
import { ctrlStaticPlugin } from "./plugins/static";
import { environmentRepo } from "./repositories";
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
import { runDataMigrations } from "./services/data-migrate";
import { getHermesClient, initHermesClient } from "./services/hermes-client";
import { findRunningInstanceByEnvironment, spawnInstanceFromEnvironment, stopAllInstances } from "./services/instance";
import { syncBuiltinSkills } from "./services/meta-agent";
import { startScheduler, stopScheduler } from "./services/scheduler";
import { resolveWorkspacePath } from "./services/workspace-resolver";
import { closeAllAcpConnections } from "./transport/acp-ws-handler";
import { closeAllFileWsConnections } from "./transport/file-ws-handler";
import { closeAllRelayConnections } from "./transport/relay";

await initDb();
startupLog.info("Database initialized");

await runDataMigrations();
startupLog.info("Data migrations completed");

// 重启时重置所有 agent_session 状态为 idle
// WebSocket/EventBus 已断开，之前的运行状态不再有效
import { sql } from "drizzle-orm";

await db.update(agentSession).set({ status: "idle", updatedAt: new Date() }).where(sql`1=1`);

const env = validateEnv();
applyEnv(env);

getCoreRuntime();
startupLog.info("Core runtime initialized");

await startScheduler();

// 同步内置 skill 到每个组织的 data/skills/
// 遍历 member 表获取所有 (orgId, userId, role) 去重后，为每个组织注册 .agents/skills/ 下的 skill
(async () => {
  try {
    const rows = await db
      .select({
        organizationId: member.organizationId,
        userId: member.userId,
        role: member.role,
      })
      .from(member);
    // 按 organizationId 去重，每个组织只同步一次（取第一个 owner/admin，否则取任意一个）
    const orgMap = new Map<string, { userId: string; role: string }>();
    for (const r of rows) {
      if (!orgMap.has(r.organizationId)) {
        orgMap.set(r.organizationId, { userId: r.userId, role: r.role });
      }
    }
    for (const [orgId, info] of orgMap) {
      try {
        await syncBuiltinSkills({
          organizationId: orgId,
          userId: info.userId,
          role: info.role as "owner" | "admin" | "member",
        });
      } catch (err) {
        startupLog.error(`Failed to sync builtin skills for org ${orgId}`, err instanceof Error ? err : undefined);
      }
    }
    if (orgMap.size > 0) {
      startupLog.info(`Builtin skills synced for ${orgMap.size} organization(s)`);
    }
  } catch (err) {
    startupLog.error("Failed to sync builtin skills", err instanceof Error ? err : undefined);
  }
})();

// Initialize Hermes client if configured
// biome-ignore lint/suspicious/noExplicitAny: config channels shape is dynamic
const hermesUrl = process.env.HERMES_URL ?? (config as any).channels?.hermesUrl;
if (hermesUrl) {
  initHermesClient(hermesUrl);
}

// Kill stale acp-link processes from previous runs
try {
  execSync("pkill -f 'acp-link.*opencode' || true", { stdio: "ignore" });
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
    // 只为没有 machineId 的 environment 本地 spawn（有 machineId 的由远端 machine 管理）
    if (env.agentConfigId) {
      const { getAgentConfigById } = await import("./services/config/agent-config");
      const agentCfg = await getAgentConfigById(env.agentConfigId);
      if (agentCfg?.machineId) continue;
    }
    const cwd = resolveWorkspacePath(env.organizationId, env.userId, env.id);
    if (!existsSync(cwd)) {
      startupLog.warn(`Skipping ${env.name}: workspace directory does not exist`);
      continue;
    }
    const existing = findRunningInstanceByEnvironment(env.id);
    if (existing) continue;
    try {
      await spawnInstanceFromEnvironment(env.userId, env.id);
      startupLog.info(`Auto-started: ${env.name}`);
    } catch (err: unknown) {
      startupLog.error(`Failed to auto-start ${env.name}`, err instanceof Error ? err : undefined);
    }
  }
})();

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
          {
            name: "Config",
            description: "Configuration management (providers, models, agents, skills, MCP)",
          },
          {
            name: "Sessions",
            description: "Session management and event streaming",
          },
          {
            name: "Environments",
            description: "ACP agent environments",
          },
          {
            name: "Instances",
            description: "Agent instance lifecycle",
          },
          { name: "Tasks", description: "Scheduled HTTP tasks" },
          {
            name: "Knowledge",
            description: "Knowledge bases and resources",
          },
          { name: "Channels", description: "IM channel bindings" },
          {
            name: "Workflow Engine",
            description: "Native DAG workflow execution engine",
          },
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
        JSON.stringify({
          error: {
            type: "PAYLOAD_TOO_LARGE",
            message: "Request body exceeds 10MB limit",
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
