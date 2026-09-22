/**
 * Webhook 接收端点（1.5c 从宿主 `apps/server/src/routes/hooks.ts` 迁回本包）。
 *
 * `POST /hooks/:publicHash`——无需认证，通过 hash 标识 trigger；收到请求后异步触发对应 workflow，
 * 立即返回 200。
 *
 * 目录形状：`routes/<协议前缀>/` 是路由目录的统一布局（本包原有 `web/`、`api/`），Webhook 与 ACP、MCP
 * 同属独立协议面，既不是控制台 `/web/*` 也不是对外 `/api/*`，因此单列一层而不是塞进上述两者之一。
 *
 * 为什么工厂不接收守卫依赖：无认证是这个端点的**协议语义**（trigger 的 `publicHash` 即凭据），
 * 而不是「守卫尚未注入」。相应地，查不到或已 disabled 的 trigger 返回同一个 404 响应，不区分
 * 「不存在」与「已禁用」，避免把 trigger 是否存在变成可探测信息。
 *
 * 唯一被消费的宿主能力是 HTTP 边缘本身，包内自足：`handleWebhookRequest` 及其仓储都在本包内，
 * 因此本工厂没有 `WorkflowRouteDependencies` 参数——与 `web/*`、`api/*` 的差别即在此。
 *
 * 迁出时恢复了一处丢失的挂载：该路由原先挂在旧入口 `src/index.ts`（提交 `38bc236f0`），FND-05 把
 * 入口迁到 `apps/server/src/main.ts` 后未带过去，导致端点自那时起不可达（详情见 review 文档
 * task-1.5-host-aggregation.md §七 1.5c）。1.5f-1b 起改由 manifest 的 `slot: "app"` 贡献声明挂载，
 * 宿主 `main.ts` 不再持有本路由的挂载点。
 */

import Elysia from "elysia";
import { handleWebhookRequest } from "../../services/workflow-trigger";

/** 请求体上限（1MB）：超过即在边缘层拒绝，不进入领域层。 */
const MAX_WEBHOOK_PAYLOAD_BYTES = 1024 * 1024;

/**
 * 构造 Webhook 接收路由。
 *
 * 只负责 HTTP 边缘——体积上限、`Headers` / `URL` 到扁平映射的投影、状态码映射；「这个 hash 该不该
 * 触发」以及触发语义都在 `services/workflow-trigger`。
 */
export function createHookRoutes() {
  return new Elysia({ name: "hooks" }).post(
    "/hooks/:publicHash",
    async ({ params, request, body, set }) => {
      const { publicHash } = params as { publicHash: string };

      const contentLength = request.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_WEBHOOK_PAYLOAD_BYTES) {
        set.status = 413;
        return { error: "payload too large" };
      }

      // headers / query 以扁平字符串映射传给领域层：WebhookPayload 是对外契约的一部分（会随 trigger
      // 输入进入 workflow 上下文），不透传 Headers / URL 这类与运行时绑定的对象。
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        headers[k] = v;
      });

      // body 可能是 JSON 对象或字符串；字符串优先按 JSON 解析，失败则原样传递（保持迁移前的语义）。
      let parsedBody: unknown = body;
      if (typeof body === "string") {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          parsedBody = body;
        }
      }

      const url = new URL(request.url);
      const queryObj: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        queryObj[k] = v;
      });

      const result = await handleWebhookRequest(publicHash, headers, parsedBody, queryObj);

      if (!result.accepted) {
        set.status = 404;
        return { error: result.error };
      }

      return { received: true };
    },
    {
      // 本路由的 `detail` 不是文档修饰而是**必需**：`@elysiajs/openapi` 在配置了 `exclude.tags` 时
      // 无条件读 `hooks.detail.tags`（1.4.15 `toOpenAPISchema`），任意一条缺 `detail` 的路由都会让
      // 整份 spec 生成抛 `TypeError: undefined is not an object`，`/docs/openapi/web/json` 与
      // `/docs/openapi/external/json` 同时 500。1.5f-1b 恢复本路由挂载时曾漏掉，故在此留说明。
      //
      // 与 `/acp`、`/skills/:name/download` 等协议入口一致：无认证是协议语义（`publicHash` 即凭据），
      // 不按 REST 建模，`hide: true` 使其不出现在公开文档中。
      detail: {
        hide: true,
        tags: ["Workflow Engine"],
        summary: "Workflow Webhook 接收入口",
        description:
          "供外部系统触发已发布 workflow 的 Webhook 入口，路径中的 `publicHash` 即凭据（无其他认证）。" +
          "命中已启用的 trigger 时异步触发对应 workflow 并返回 200，未命中或已禁用统一返回 404。" +
          "该接口属内部协议面，默认不在公开文档中展示。",
      },
    },
  );
}
