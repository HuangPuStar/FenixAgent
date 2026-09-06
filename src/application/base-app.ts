import Elysia from "elysia";
import type { AppConfig } from "../config";
import { createExternalOpenApiPlugin, createWebOpenApiPlugin } from "../openapi";
import { authPlugin } from "../plugins/auth";
import { corsPlugin } from "../plugins/cors";
import { errorPlugin } from "../plugins/error-handler";
import { deriveRequestId, injectRequestId, logRequest, logResponse } from "../plugins/logger";
import { ctrlStaticPlugin } from "../plugins/static";
import { buildHealthInfo } from "../services/build-info";

/** Community base app 纯构造所需的最小宿主参数。 */
export interface CommunityBaseAppOptions {
  readonly config: Pick<AppConfig, "version" | "wsMaxPayloadMb">;
  readonly startedAt: string;
}

/** 构造社区版固定横切能力，不启动任何外部资源。 */
export function createCommunityBaseApp(options: CommunityBaseAppOptions) {
  return (
    new Elysia({
      websocket: {
        maxPayloadLength: options.config.wsMaxPayloadMb * 1024 * 1024,
      },
    })
      .use(corsPlugin)
      .use(createExternalOpenApiPlugin(options.config.version))
      .use(createWebOpenApiPlugin(options.config.version))
      .derive(deriveRequestId)
      .onBeforeHandle(logRequest)
      .onAfterResponse(logResponse)
      .onAfterHandle(injectRequestId)
      // SPA fallback 必须先于统一错误映射处理静态 404。
      .use(ctrlStaticPlugin)
      .use(errorPlugin)
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
      .get("/health", () => ({ ...buildHealthInfo(options.startedAt), version: options.config.version }))
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
            description:
              "服务根路径访问时统一重定向到 `/ctrl/` 控制台首页。该入口仅用于站点导航，默认不在公开文档中展示。",
          },
        },
      )
      .use(authPlugin)
  );
}
