/**
 * Webhook 接收端点。
 *
 * POST /hooks/:publicHash — 无需认证，通过 hash 标识 trigger。
 * 收到请求后异步触发对应 workflow，立即返回 200。
 */
import Elysia from "elysia";
import { handleWebhookRequest } from "../services/workflow-trigger";

const app = new Elysia({ name: "hooks" });

app.post("/hooks/:publicHash", async ({ params, request, body, query, error }) => {
  const { publicHash } = params as { publicHash: string };

  // 请求体大小检查（1MB）
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > 1024 * 1024) {
    return error(413, { error: "payload too large" });
  }

  // 提取 headers
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });

  // body 可能是 JSON 对象或字符串
  let parsedBody: unknown = body;
  if (typeof body === "string") {
    try {
      parsedBody = JSON.parse(body);
    } catch {
      parsedBody = body;
    }
  }

  // 提取 query params
  const url = new URL(request.url);
  const queryObj: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    queryObj[k] = v;
  });

  const result = await handleWebhookRequest(publicHash, headers, parsedBody, queryObj);

  if (!result.accepted) {
    return error(404, { error: result.error });
  }

  return { received: true };
});

export default app;
