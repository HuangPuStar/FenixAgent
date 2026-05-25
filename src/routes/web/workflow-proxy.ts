import Elysia from "elysia";
import { config } from "../../config";
import { authGuardPlugin } from "../../plugins/auth";

/** 将请求转发到 acpx-g 并流式返回响应 */
async function proxyToAcpxG(targetPath: string, request: Request): Promise<Response> {
  const targetUrl = `${config.acpxGUrl}${targetPath}`;
  const headers = new Headers(request.headers);
  headers.set("Host", new URL(config.acpxGUrl).host);
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  try {
    const res = await fetch(targetUrl, init);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (err: unknown) {
    return new Response(
      JSON.stringify({
        error: {
          type: "bad_gateway",
          message: `acpx-g unreachable: ${err instanceof Error ? err.message : String(err)}`,
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

// 静态资源代理：挂载到 /workflow-ui，转发到 acpx-g 根路径
export const workflowStaticApp = new Elysia({ name: "workflow-static", prefix: "/workflow-ui" })
  .use(authGuardPlugin)
  .all("/", ({ request }) => proxyToAcpxG("/", request), { sessionAuth: true })
  .all("/:path", ({ params, request }) => proxyToAcpxG(`/${params.path}`, request), { sessionAuth: true });

// API 代理：挂载到 /api/v1，转发到 acpx-g 的 /api/v1/* 路径
export const workflowApiApp = new Elysia({ name: "workflow-api", prefix: "/api/v1" })
  .use(authGuardPlugin)
  .all("/:path", ({ params, request }) => proxyToAcpxG(`/api/v1/${params.path}`, request), { sessionAuth: true });
