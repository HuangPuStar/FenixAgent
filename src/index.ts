import { createLogger, interceptConsole } from "@fenix/logger";
import * as z from "zod/v4";

// ⚠️ 必须在所有其他代码之前拦截 console，保证全局日志统一
interceptConsole();

const startupLog = createLogger("rcs");

import { execSync } from "node:child_process";
import openapi from "@elysiajs/openapi";
import Elysia from "elysia";
import { applyEnv, config } from "./config";
import { db, initDb, client as pgClient } from "./db";
import { agentSession } from "./db/schema";
import { validateEnv } from "./env";
import { authPlugin } from "./plugins/auth";
import { corsPlugin } from "./plugins/cors";
import { errorPlugin } from "./plugins/error-handler";
import { deriveRequestId, logError, logRequest, logResponse } from "./plugins/logger";
import { rateLimitPlugin } from "./plugins/rate-limit";
import { ctrlStaticPlugin } from "./plugins/static";
import acpRoutes from "./routes/acp";
import apiAgentsRoutes from "./routes/api/agents";
import apiSkillsRoutes from "./routes/api/skills";
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
import { stopAllInstances } from "./services/instance";
import { startScheduler, stopScheduler } from "./services/scheduler";
import { syncBuiltin } from "./services/sync-builtin";
import { ensureSystemAdmin } from "./services/system-admin";
import { closeAllAcpConnections } from "./transport/acp-ws-handler";
import { closeAllFileWsConnections } from "./transport/file-ws-handler";
import { closeAllRelayConnections } from "./transport/relay";

const API_OPENAPI_PATH = "/docs/openapi/external";
const API_OPENAPI_SPEC_PATH = `${API_OPENAPI_PATH}/json`;
const WEB_OPENAPI_PATH = "/docs/openapi/web";
const WEB_OPENAPI_SPEC_PATH = `${WEB_OPENAPI_PATH}/json`;

const EXTERNAL_OPENAPI_TAGS = [
  {
    name: "External AgentConfig",
    description: "面向外部系统的 Agent 配置 CRUD 接口。",
  },
  {
    name: "External Skill",
    description: "面向外部系统的 Skill 管理接口。",
  },
];

const WEB_OPENAPI_TAGS = [
  {
    name: "AgentConfig",
    description: "Agent 配置管理，包括列表查询、详情读取、创建、更新、删除和默认 Agent 设置。",
  },
  {
    name: "ProviderConfig",
    description: "Provider 配置管理，包括供应商凭证、连接测试和模型条目维护。",
  },
  {
    name: "ModelConfig",
    description: "模型配置管理，包括当前默认模型设置和可用模型列表刷新。",
  },
  {
    name: "SkillConfig",
    description: "Skill 配置管理，包括技能查询、编辑、删除与批量上传导入。",
  },
  {
    name: "McpConfig",
    description: "MCP 服务配置管理，包括服务增删改查、启停、测试和工具检查。",
  },
  {
    name: "Sessions",
    description: "会话管理与事件历史查询。",
  },
  {
    name: "Environments",
    description: "Agent 运行环境管理。",
  },
  {
    name: "Instances",
    description: "Agent 实例的启动、查询与销毁。",
  },
  {
    name: "Control",
    description: "会话控制接口，包括事件发送、控制指令和中断操作。",
  },
  {
    name: "Files",
    description: "环境工作区文件管理，包括文件内容读写、文件树、目录操作与批量删除。",
  },
  {
    name: "Auth",
    description: "认证相关扩展接口，包括会话归属绑定等能力。",
  },
  {
    name: "Branding",
    description: "品牌展示配置接口，包括品牌名称和 Logo 资源获取。",
  },
  {
    name: "Tasks",
    description: "定时 HTTP 任务管理与执行日志查询。",
  },
  {
    name: "Organizations",
    description: "组织、成员和 API Key 管理。",
  },
  {
    name: "Knowledge",
    description: "知识库与知识资源管理。",
  },
  {
    name: "Channels",
    description: "IM 通道绑定与消息路由配置。",
  },
  {
    name: "Registry",
    description: "机器注册表管理，包括机器列表、详情与事件历史查询。",
  },
  {
    name: "Meta Agent",
    description: "Meta Agent 自举与运行环境确保接口。",
  },
  {
    name: "Hindsight",
    description: "Hindsight 记忆服务状态查询与相关能力入口。",
  },
  {
    name: "ACP",
    description: "ACP 机器接入、Relay 中继与 Agent 列表查询接口。",
  },
  {
    name: "Code Session",
    description: "Code Session、Worker 状态同步、Bridge 接入与 Session Ingress 相关接口。",
  },
  {
    name: "Workflow Engine",
    description: "原生 DAG 工作流执行引擎相关接口。",
  },
];

const EXTERNAL_DOC_TAG_NAMES = EXTERNAL_OPENAPI_TAGS.map((tag) => tag.name);
const WEB_DOC_TAG_NAMES = WEB_OPENAPI_TAGS.map((tag) => tag.name);

const DOC_EXCLUDED_PATHS: Array<string | RegExp> = [
  "/health",
  API_OPENAPI_PATH,
  API_OPENAPI_SPEC_PATH,
  WEB_OPENAPI_PATH,
  WEB_OPENAPI_SPEC_PATH,
];

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

// 定期巡检：将无活跃 WS 连接的 machine 标为 offline（处理服务重启、网络分区等场景）
import("./services/registry-heartbeat").then(({ startMachineSweep }) => {
  startMachineSweep(60_000);
});

const app = new Elysia()
  .use(corsPlugin)
  .use(
    openapi({
      documentation: {
        info: {
          title: "Fenix External API",
          version: config.version,
          description: "面向外部系统的 API 文档。",
        },
        tags: EXTERNAL_OPENAPI_TAGS,
      },
      provider: "scalar",
      scalar: {
        url: API_OPENAPI_SPEC_PATH,
      },
      mapJsonSchema: {
        zod: z.toJSONSchema,
      },
      exclude: {
        paths: DOC_EXCLUDED_PATHS,
        tags: WEB_DOC_TAG_NAMES,
      },
      path: API_OPENAPI_PATH,
      specPath: API_OPENAPI_SPEC_PATH,
    }),
  )
  .use(
    openapi({
      documentation: {
        info: {
          title: "Fenix Web API",
          version: config.version,
          description: "控制台内部 /web 及平台接口文档。",
        },
        tags: WEB_OPENAPI_TAGS,
      },
      provider: "scalar",
      scalar: {
        url: WEB_OPENAPI_SPEC_PATH,
      },
      mapJsonSchema: {
        zod: z.toJSONSchema,
      },
      exclude: {
        paths: DOC_EXCLUDED_PATHS,
        tags: EXTERNAL_DOC_TAG_NAMES,
      },
      path: WEB_OPENAPI_PATH,
      specPath: WEB_OPENAPI_SPEC_PATH,
    }),
  )
  .derive(deriveRequestId)
  .onBeforeHandle(logRequest)
  .onAfterHandle(logResponse)
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
  // External API routes
  .use(apiAgentsRoutes)
  .use(apiSkillsRoutes)
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
