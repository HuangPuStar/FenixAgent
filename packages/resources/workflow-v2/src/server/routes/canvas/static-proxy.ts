import { Elysia } from "elysia";
import { CANVAS_STORAGE_SEGMENT, createCanvasUpstreamProxy } from "../../services/upstream-proxy";

/**
 * `/workflow-canvas/*` — 上游自带前端的静态反代（设计 §5.1，冻结 §2.1 的 `workflow-v2.canvas-static`）。
 *
 * 控制台域下由我方服务器把画布资产反代到 `WORKFLOW_CANVAS_UPSTREAM_URL`（内网上游服务），同源之后 iframe
 * 无需 CORS、深链刷新不 404。三条路由规则：
 *
 * - `/workflow-canvas/<rest>` → 上游同路径；根路径 → 上游 `/`；非静态资源的上游 404 回退到上游根文档
 *   （SPA 深链，见 `upstream-proxy.ts` 的 `proxyAsset`）；
 * - `/workflow-canvas/storage/<rest>` → 对象存储 origin（冻结 §6.1），只允许 GET/HEAD；
 * - `bff/` 前缀必须跳过：`/workflow-canvas/bff/*` 是 1D 的透传面。声明序（bff 在前、本面在后）保证正常
 *   挂载下请求先落到 bff 面，但本面是通配路由，**handler 内仍显式判定并放行**作为第二道保险——若因挂载序
 *   错乱而先匹配到，也要返回 404 而不是把 API 请求转成上游的 index.html。
 *
 * 本面在 `app` 槽贡献上**不带会话守卫**（冻结 §2.1）：凭据是同源 iframe 的静态资产场景，真正的访问控制
 * 落在票据与 bff 面。它因此不解释任何平台数据——只转发上游的资产，且**出站注入平台账号会话**（不带
 * cookie 时上游对 `/workflow-canvas/*` 一律 401，实测见设计 §9.1.1 第 2 条），**入站剥离上游
 * `Set-Cookie`** 并注入 `frame-ancestors` 让画布只被控制台自身嵌入。两条方向都由 `upstream-proxy.ts`
 * 统一执行，本文件只做协议适配。
 *
 * `hide: true` 与 `bff.ts` 同因：静态资产不按 REST 建模（与既有 `/workflow-ui/*` 口径一致）。
 */
export function createCanvasStaticRoutes() {
  // 代理实例持有存储域 origin 的解析结果；路由工厂每构造一次即一份干净状态（生产只在装配期构造一次）。
  const proxy = createCanvasUpstreamProxy();

  return new Elysia({ name: "workflow-canvas-static", prefix: "/workflow-canvas" })
    .all("/", ({ request }) => proxy.proxyAsset(request, ""), {
      detail: {
        hide: true,
        tags: ["Workflow V2"],
        summary: "反代画布入口文档",
        description: "`/workflow-canvas/`（与不带尾斜杠的 `/workflow-canvas`）映射到上游根路径 `/`。",
      },
    })
    .all(`/${CANVAS_STORAGE_SEGMENT}/*`, ({ request, params }) => proxy.proxyStorage(request, params["*"] ?? ""), {
      detail: {
        hide: true,
        tags: ["Workflow V2"],
        summary: "反代画布存储域",
        description:
          "`/workflow-canvas/storage/<rest>` 映射到对象存储 origin（由上游签名直链推导），仅 GET/HEAD；" +
          "不带平台会话、剥离 Set-Cookie（冻结 §6.1）。",
      },
    })
    .all("/*", ({ request, params }) => proxy.proxyAsset(request, params["*"] ?? ""), {
      detail: {
        hide: true,
        tags: ["Workflow V2"],
        summary: "反代画布静态资源",
        description:
          "把 `/workflow-canvas/<rest>` 反代到 `WORKFLOW_CANVAS_UPSTREAM_URL/<rest>`；出站注入平台账号会话，" +
          "入站剥离 Set-Cookie 并注入 `frame-ancestors 'self'`；非静态资源的 404 回退到上游根文档；" +
          "`bff/` 前缀不代理（属 bff 透传面）。",
      },
    });
}
