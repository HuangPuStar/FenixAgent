import { createLogger, interceptConsole } from "@fenix/logger";

// ⚠️ 必须在所有其他代码之前拦截 console，保证全局日志统一
interceptConsole();

const startupLog = createLogger("rcs");

import type { WebSocketHandler } from "bun";
import Elysia from "elysia";
import { shutdownHostRuntime, startHostRuntime } from "./bootstrap/host-startup";
import { wireHostRuntime } from "./bootstrap/host-wiring";
import { API_SLOT, APP_SLOT, takeRouteContributions, WEB_CONFIG_SLOT, WEB_SLOT } from "./bootstrap/route-contributions";
import { applyEnv, config } from "./config";
import { loadServerEnv } from "./env-loader";
import { createExternalOpenApiPlugin, createWebOpenApiPlugin } from "./openapi";
import { authPlugin } from "./plugins/auth";
import { corsPlugin } from "./plugins/cors";
import { errorPlugin } from "./plugins/error-handler";
import { deriveRequestId, injectRequestId, logRequest, logResponse } from "./plugins/logger";
import { ctrlStaticPlugin } from "./plugins/static";
import { createApiApp } from "./routes/api";
import { createWebApp } from "./routes/web";
import { buildHealthInfo } from "./services/build-info";

/**
 * 服务入口：只保留「进程边界」相关的四件事——读 env、建 app、listen、接信号。
 *
 * 启动序与关闭序都在 `bootstrap/host-startup.ts`（顺序约束成文在那里），装配期接线在
 * `bootstrap/host-wiring.ts`，模块装配在 `bootstrap.ts`。入口不持有任何包的具体实现依赖（除日志）——
 * 它只经 `./bootstrap/*` 与宿主自己的 plugins/routes 组装，因此「新增一个资源模块」不会改动本文件
 * （由 `deploy/assembly/ce.json` 的 profile 与模块 manifest 决定）。
 */
const startedAt = new Date().toISOString();

const env = loadServerEnv([]);
applyEnv(env);

// 装配期接线 + 启动序（两者都必须在 app 构造前完成：`app-route` 贡献是在装配时登记、在下方
// `takeRouteContributions()` 处被消费的）。
const { agentRuntime } = wireHostRuntime(env, config);
await startHostRuntime(env, agentRuntime);

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
  // Web control panel routes：装配期登记的 app-route 贡献按聚合槽注入（未启用贡献的槽位为空数组）
  .use(createWebApp({ web: takeRouteContributions(WEB_SLOT), webConfig: takeRouteContributions(WEB_CONFIG_SLOT) }))
  // External API routes：装配期登记的 app-route 贡献按 `api` 聚合槽注入
  // （`/api/agents`、`/api/knowledge-bases`、`/api/skills`、`/api/models`、`/api/mcp`、
  // `/api/system/*`、`/api/environments/*`、`/api/workflows/*` 与 OpenAI 兼容对话端点）
  .use(createApiApp({ api: takeRouteContributions(API_SLOT) }))
  // 顶层协议入口：`/acp/*`、`/mcp/knowledge`、`/skills/:name/download`、`/workflow-ui/*`、
  // `/hooks/:publicHash`、`/web/site/deploy/:appId/*` 与 `/app-*` 兜底。它们各自带独立前缀与认证口径，
  // 只有「代理还是兜底」这一层差别——兜底通配 `/*` 必须最后注册，由该贡献自己的大 `order` 自证
  // （见 `agent-config/fenix.module.ts`），宿主不维护「谁必须最后挂」的清单。
  .use([...takeRouteContributions(APP_SLOT)]);

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

/**
 * 信号处理与关闭幂等：关闭序在 `bootstrap/host-startup.ts`，这里只保证「并发/重复信号只关一次」。
 *
 * 关闭完成后直接 `process.exit(0)`：宿主尚持有 uWS 等非事件循环可回收的句柄（Bun 的 server 不随
 * `Promise` 结束释放），不显式退出会让进程挂着不退。
 */
let gracefulShutdownPromise: Promise<void> | null = null;

function gracefulShutdown(signal: string): Promise<void> {
  if (gracefulShutdownPromise) return gracefulShutdownPromise;
  gracefulShutdownPromise = (async () => {
    startupLog.info(`Received ${signal}, shutting down...`);
    await shutdownHostRuntime(agentRuntime);
    process.exit(0);
  })();
  return gracefulShutdownPromise;
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
