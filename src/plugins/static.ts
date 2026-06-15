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
  // /ctrl/:sessionId/user/* → redirect to file preview API (for iframe embedding)
  .get(
    "/ctrl/:sessionId/user/:filePath",
    ({ params, redirect }) => {
      return redirect(`/web/sessions/${params.sessionId}/user/${params.filePath}?preview=true`);
    },
    {
      detail: {
        hide: true,
        summary: "控制台文件预览跳转",
        description:
          "将 `/ctrl/:sessionId/user/:filePath` 形式的控制台预览地址重定向到实际的文件预览 API，用于 iframe 等前端预览场景。该接口属于控制台内部跳转能力，默认不在公开文档中展示。",
      },
    },
  )
  // SPA fallback: when static plugin returns 404 for /ctrl/* paths without file extensions,
  // serve index.html so the client-side router can handle SPA navigation on refresh
  .onError(({ error, request, set }) => {
    if (!("status" in error) || error.status !== 404) return;
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/ctrl/")) return;
    // Skip paths with file extensions (JS, CSS, images, fonts, etc.)
    if (extname(url.pathname)) return;
    if (!existsSync(indexHtmlPath)) return;
    set.headers["Content-Type"] = "text/html; charset=utf-8";
    return new Response(Bun.file(indexHtmlPath));
  });
