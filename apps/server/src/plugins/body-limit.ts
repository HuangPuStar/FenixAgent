import { AppError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { formatApiError } from "../protocol/api-response";

/**
 * HTTP 请求体上限是全站内存兜底，文件单体 92MiB 由文件门面另行校验。
 * 保留 108MiB 传输预算，为 multipart 头部和目录元信息留出余量；
 * 请求体上限必须高于文件服务硬上限，关系由 request-body-limit.test.ts 守护。
 */
export const MAX_REQUEST_BODY_BYTES = 108 * 1024 * 1024;

/**
 * `content-length` 是否超过宿主上限。
 *
 * 缺失或非数值时不推测长度，改由宿主计数流限制实际读取总量。
 */
export function isRequestBodyOverLimit(contentLength: string | null): boolean {
  if (!contentLength) return false;
  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed > MAX_REQUEST_BODY_BYTES;
}

/**
 * 全局请求体大小守卫（文件上传、工作流任务等场景的内存兜底）。
 *
 * 超限时直接返回 413 响应体，不进入下游 route——省掉把大 body 读进内存再判定的开销。挂载位置必须在
 * 聚合路由（`/web`、`/api`、顶层协议入口）之前，否则 body 已被解析，这道闸门形同虚设。
 */
export const bodyLimitPlugin = new Elysia({ name: "body-limit" }).onRequest((context) => {
  const { request } = context;
  if (!isRequestBodyOverLimit(request.headers.get("content-length"))) {
    if (request.body) {
      let received = 0;
      const reader = request.body.getReader();
      context.request = new Request(request, {
        body: new ReadableStream<Uint8Array>({
          async pull(controller) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              reader.releaseLock();
              return;
            }
            received += next.value.byteLength;
            if (received > MAX_REQUEST_BODY_BYTES) {
              await reader.cancel();
              reader.releaseLock();
              throw new AppError("Request body exceeds the server transport limit (108MB)", "PAYLOAD_TOO_LARGE", 413);
            }
            controller.enqueue(next.value);
          },
          async cancel(reason) {
            await reader.cancel(reason);
            reader.releaseLock();
          },
        }),
      });
    }
    return;
  }
  const limitMb = MAX_REQUEST_BODY_BYTES / (1024 * 1024);
  return new Response(
    JSON.stringify(
      formatApiError(
        request.url,
        "PAYLOAD_TOO_LARGE",
        `Request body exceeds the server transport limit (${limitMb}MB)`,
        413,
      ),
    ),
    {
      status: 413,
      headers: { "Content-Type": "application/json" },
    },
  );
});
