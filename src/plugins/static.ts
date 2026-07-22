import { existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { staticPlugin } from "@elysiajs/static";
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
  .onError(({ error, request, set }) => {
    if (!("status" in error) || error.status !== 404) return;
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/ctrl/")) return;
    // 带扩展名的资源（JS、CSS、图片、字体等）缺失应保持 404，不回退
    if (extname(url.pathname)) return;
    if (!existsSync(indexHtmlPath)) return;
    set.status = 200;
    set.headers["Content-Type"] = "text/html; charset=utf-8";
    return new Response(Bun.file(indexHtmlPath), { status: 200 });
  });
