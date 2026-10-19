import Elysia from "elysia";

/**
 * HTTP 请求体上限是全站内存兜底，文件单体 92MiB 由文件门面另行校验。
 * 保留 108MiB 传输预算，为 multipart 头部和目录元信息留出余量；
 * 请求体上限必须高于文件服务硬上限，关系由 request-body-limit.test.ts 守护。
 */
export const MAX_REQUEST_BODY_BYTES = 108 * 1024 * 1024;

/**
 * `content-length` 是否超过宿主上限。
 *
 * 缺失或非数值一律放行：这两种形态（chunked、畸形头）都拿不到可信长度，交由 Bun 自身的请求体上限与
 * 下游 route 的实际读取兜底，宿主不在这里猜。
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
export const bodyLimitPlugin = new Elysia({ name: "body-limit" }).onBeforeHandle({ as: "global" }, ({ request }) => {
  if (!isRequestBodyOverLimit(request.headers.get("content-length"))) return;
  // 文案只报传输层上限，不再自称 100MB：与产品单文件上限混淆正是 AOS-BUG-005 的现场误判来源
  // （报告据此怀疑后端按 1000 换算）。
  const limitMb = MAX_REQUEST_BODY_BYTES / (1024 * 1024);
  return new Response(
    JSON.stringify({
      error: {
        type: "PAYLOAD_TOO_LARGE",
        message: `Request body exceeds the server transport limit (${limitMb}MB)`,
      },
    }),
    {
      status: 413,
      headers: { "Content-Type": "application/json" },
    },
  );
});
