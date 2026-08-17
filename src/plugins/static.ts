import { existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staticPlugin } from "@elysiajs/static";
import { createLogger } from "@fenix/logger";
import Elysia from "elysia";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = process.cwd();
const distDir = resolve(cwd, "web/dist");
const srcDir = resolve(__dirname, "../../web/dist");
const webDir = existsSync(resolve(distDir, "index.html"))
  ? distDir
  : existsSync(resolve(srcDir, "index.html"))
    ? srcDir
    : resolve(cwd, "web");
const indexHtmlPath = resolve(webDir, "index.html");
const logger = createLogger("http");

export const ctrlStaticPlugin = new Elysia({ name: "ctrl-static" })
  .use(
    staticPlugin({
      assets: webDir,
      prefix: "/ctrl",
      indexHTML: true,
      detail: {
        hide: true,
        summary: "控制台静态资源入口",
        description:
          "控制台前端页面与静态资源的托管入口，包括 `/ctrl` 根页面和其下的脚本、样式、图片等资源。该入口属于前端静态分发能力，默认不在公开文档中展示。",
      },
    }),
  )
  // ProdView 分享短链接重定向 → 实际 SPA 路由
  .get(
    "/view/:id",
    ({ params, redirect }) => {
      return redirect(`/ctrl/view/${params.id}`);
    },
    {
      detail: {
        hide: true,
        summary: "ProdView 分享短链接重定向",
        description: "将 `/view/:id` 短分享链接重定向到 `/ctrl/view/:id` 的实际 SPA 路由，对应前端 basename 前缀。",
      },
    },
  )
  // SPA fallback：前端是客户端路由。刷新 `/ctrl/*` 深层路径（如 `/ctrl/agent/home`）时，
  // @elysiajs/static 找不到对应文件会抛 404，这里回退到 index.html 让前端路由接管。
  //
  // 关键：必须显式把状态码重置为 200。onError 触发时 set.status 已被置为 404，
  // 只返回 index.html 而不重置状态，浏览器仍会记录一条 404（虽然页面能渲染），
  // 也会污染控制台并可能影响缓存/预取等行为。
  //
  // 必须显式 `{ as: "global" }`：Elysia 的 use() 只合并 scope 为 global/scoped 的
  // hook，onError 默认 scope 是 local，缺省时本 fallback 对主 app 从未生效。
  // 同时本插件必须 use 在 errorPlugin 之前（见 index.ts）：errorPlugin 对所有
  // 错误都返回 JSON 响应并终止 onError 链，若在其后注册，SPA fallback 永远
  // 轮不到执行。
  //
  // 日志不能复用 logError：@elysiajs/static 的 indexHTML 机制会把 set.status
  // 先改写为 200（链开始前已非 404），logError 会因此误判为非 SPA fallback
  // 打 ERROR 日志，这里按 logError 的 SPA_FALLBACK 分支格式自行记录 info。
  .onError({ as: "global" }, ({ error, request, set }) => {
    if (!("status" in error) || error.status !== 404) return;
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/ctrl/")) return;
    // 带扩展名的资源（JS、CSS、图片、字体等）缺失应保持 404，不回退
    if (extname(url.pathname)) return;
    if (!existsSync(indexHtmlPath)) return;
    // biome-ignore lint/suspicious/noExplicitAny: custom request properties injected by logger derive hook
    const start = (request as any).__startTime as number | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: custom request property injected by logger derive hook
    const id = (request as any).__requestId as string | undefined;
    const ms = start != null ? performance.now() - start : -1;
    logger.info(`${request.method} ${url.pathname} 404 ${ms.toFixed(2)}ms [${id ?? "n/a"}] SPA_FALLBACK`);
    set.status = 200;
    set.headers["Content-Type"] = "text/html; charset=utf-8";
    return new Response(Bun.file(indexHtmlPath), { status: 200 });
  });
