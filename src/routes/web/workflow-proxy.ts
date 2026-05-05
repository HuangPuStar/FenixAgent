import { Hono } from "hono";
import { config } from "../../config";
import { sessionAuth } from "../../auth/middleware";

/** 将请求转发到 acpx-g 并流式返回响应 */
async function proxyToAcpxG(
  targetPath: string,
  request: Request,
): Promise<Response> {
  const targetUrl = `${config.acpxGUrl}${targetPath}`;
  const init: RequestInit = {
    method: request.method,
    headers: { ...request.headers, Host: new URL(config.acpxGUrl).host },
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
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: { type: "bad_gateway", message: `acpx-g unreachable: ${err.message}` } }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

// 静态资源代理：挂载到 /workflow-ui，转发到 acpx-g 根路径
export const workflowStaticApp = new Hono();
workflowStaticApp.use("/*", sessionAuth);
workflowStaticApp.all("/", async (c) => {
  return proxyToAcpxG("/", c.req.raw);
});
workflowStaticApp.all("/:path{.*}", async (c) => {
  const path = c.req.param("path");
  return proxyToAcpxG(`/${path}`, c.req.raw);
});

// API 代理：挂载到 /api/v1，转发到 acpx-g 的 /api/v1/*
export const workflowApiApp = new Hono();
workflowApiApp.use("/*", sessionAuth);
workflowApiApp.all("/", async (c) => {
  return proxyToAcpxG("/api/v1", c.req.raw);
});
workflowApiApp.all("/:path{.*}", async (c) => {
  const path = c.req.param("path");
  return proxyToAcpxG(`/api/v1/${path}`, c.req.raw);
});
