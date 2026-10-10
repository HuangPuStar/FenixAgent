import Elysia from "elysia";

/**
 * 宿主请求体上限：进程级内存兜底，**不是**任何资源的产品上限。
 *
 * 产品口径是「单文件 ≤ 100MB（本地环境）」——权威校验在 `@fenix/resource-machine` 的文件门面
 * （`LOCAL_UPLOAD_MAX_BYTES`，远程 20MB，见 `docs/arch/12-files.md` §2.4 能力上限不对称条款），
 * 而 HTTP 请求体除文件字节外还有 multipart 框架开销：每条 part 的 boundary 与 `Content-Disposition`
 * 头部、文件夹上传的 `relativePaths` 字段。两者取同一个数时，恰好 100MB（前端按 100×1024×1024 放行）
 * 的文件在宿主层就被拒（413 `PAYLOAD_TOO_LARGE`），根本到不了门面的按文件校验——AOS-BUG-005 现场即此。
 *
 * 因此宿主上限 = 单文件上限 + 框架余量。余量按 multipart 开销的量级取：批量上传把单批文件字节数压在
 * 20MB（前端 `MAX_UPLOAD_BATCH_SIZE_BYTES`）以内，但批次内文件数可达数千，头部与 `relativePaths`
 * JSON 仍有 MB 级空间，8MB 留足且不改变「单请求不超过两个量级」的兜底性质。
 *
 * 单文件上限变更时必须同步这里：`apps/server/src/__tests__/request-body-limit.test.ts` 用
 * `LOCAL_UPLOAD_MAX_BYTES` 钉住两者关系（相等即回归 AOS-BUG-005）。
 */
const LOCAL_UPLOAD_FILE_LIMIT_BYTES = 100 * 1024 * 1024;
const MULTIPART_FRAMING_ALLOWANCE_BYTES = 8 * 1024 * 1024;

/** 宿主请求体上限（108MB = 100MB 单文件 + 8MB multipart 框架余量）。 */
export const MAX_REQUEST_BODY_BYTES = LOCAL_UPLOAD_FILE_LIMIT_BYTES + MULTIPART_FRAMING_ALLOWANCE_BYTES;

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
