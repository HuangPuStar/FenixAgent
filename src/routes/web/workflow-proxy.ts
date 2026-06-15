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
  .all("/", ({ request }) => proxyToAcpxG("/", request), {
    sessionAuth: true,
    detail: {
      hide: true,
      tags: ["Workflow Engine"],
      summary: "访问 Workflow UI 代理入口",
      description:
        "将 `/workflow-ui/` 请求透传到内部 `acpx-g` 服务根路径，用于加载工作流前端界面入口。该接口是静态资源代理，具体响应内容取决于下游服务。",
    },
  })
  .all("/:path", ({ params, request }) => proxyToAcpxG(`/${params.path}`, request), {
    sessionAuth: true,
    detail: {
      hide: true,
      tags: ["Workflow Engine"],
      summary: "访问 Workflow UI 代理资源",
      description:
        "将 `/workflow-ui/:path` 请求透传到内部 `acpx-g` 服务对应路径，用于加载工作流页面依赖的脚本、样式和其他静态资源。该接口是透传代理，不在当前文档中展开下游资源结构。",
    },
  });

// API 代理：挂载到 /api/v1，转发到 acpx-g 的 /api/v1/* 路径
export const workflowApiApp = new Elysia({ name: "workflow-api", prefix: "/api/v1" })
  .use(authGuardPlugin)
  .all("/:path", ({ params, request }) => proxyToAcpxG(`/api/v1/${params.path}`, request), {
    sessionAuth: true,
    detail: {
      hide: true,
      tags: ["Workflow Engine"],
      summary: "访问 Workflow API 代理接口",
      description:
        "将 `/api/v1/:path` 请求透传到内部 `acpx-g` 的同名 API 路径。前端工作流页面会通过该入口调用下游工作流服务，但响应协议由 `acpx-g` 决定，因此当前文档仅标注代理职责，不在此重复声明下游各接口模型。",
    },
  });
