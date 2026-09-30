import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import * as z from "zod/v4";
import { issueCode } from "../../services/iframe-ticket";
import type { WorkflowV2ActorContext, WorkflowV2RouteDependencies } from "../dependencies";

/**
 * `/web/workflow-v2/iframe-code` — 一次性 code 的签发（冻结 §7 / 设计 §5.2）。
 *
 * code 绑定 user + org + workflow、默认 60 秒有效、单次消费；宿主页拿到后经 `postMessage` 下发给画布
 * （**不放进 iframe URL**：URL 会进 referrer、历史与代理日志）。这里只签发 code，票据兑换在
 * `/workflow-canvas/bff/session/exchange`。
 *
 * 身份只取自已鉴权的会话上下文（`store.authContext`，宿主守卫写入）：请求体里的 `userId` / `orgId`
 * 既不读也不转发，且 body schema 用 `strictObject` 直接拒绝未知字段——客户端自报身份在这里既无效
 * 也可察觉（多带字段会得到 422，而不是被静默忽略后误以为生效）。
 *
 * `workflowId` 是 **上游 workflow ID**（画布 `?wf=` 参数）：`claims.wf` 要与透传请求里的显式
 * `workflow_id` 逐字一致，且由注册表复核归属（冻结 §6）。本端点不查注册表：归属复核在每次透传请求上
 * 都做，签发处再查一次只会把 2B 的注册表变成签发路径的硬依赖，而 code 未被兑换就什么也做不了。
 *
 * 一对 schema 内联在本文件：本包 `src/server/schemas/` 目录尚未建立（1A 未建），而 1C 的文件域只有本
 * 文件，另建目录会与并行任务撞车。后端规范 §7.4 要求 schema 落在 `src/server/schemas/`，待骨架补齐后
 * 本文件的两个 schema 应当整体搬过去（本注释即移除条件）。
 */

/** 请求体：`workflowId` 必填，`view` 只做协议形状兼容（画布初始视图，不参与凭据绑定）。 */
const IframeCodeRequestSchema = z.strictObject({
  workflowId: z.string().min(1).describe("上游 workflow ID，即画布 iframe 的 wf 参数。"),
  view: z.string().min(1).max(32).optional().describe("画布初始视图（canvas / test-run），不参与凭据绑定。"),
});

/** 响应体：一次性 code 与其有效期（秒）。 */
const IframeCodeResponseSchema = WebOkSchema(
  z.object({
    code: z.string().min(1).describe("一次性 code；只经 postMessage 下发，不进 URL、不进日志。"),
    expiresIn: z.number().int().positive().describe("code 有效期（秒）。"),
  }),
);

/** 签发 `/web/workflow-v2/iframe-code` 的控制台路由工厂；守卫由宿主注入（理由见 `../dependencies`）。 */
export function createWebWorkflowV2IframeCodeRoutes(deps: WorkflowV2RouteDependencies) {
  const app = new Elysia({ name: "web-workflow-v2-iframe-code" }).use(deps.authGuardPlugin);

  app.post(
    "/iframe-code",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 body/response schema 与 sessionAuth 组合下类型推断不稳定（同既有 /web 路由）
    ({ store, body, status }: any) => {
      const actor = store.authContext as WorkflowV2ActorContext | null;
      // 无组织上下文的会话拿不到工作流，签发凭据更不该放行（与既有 /web 路由的 401 口径一致）。
      if (!actor) {
        return status(401, {
          success: false as const,
          error: { code: "unauthorized", message: "请求缺少组织上下文" },
        });
      }

      const { code, expiresIn } = issueCode({
        userId: actor.userId,
        orgId: actor.organizationId,
        workflowId: (body as { workflowId: string }).workflowId,
      });
      return { success: true as const, data: { code, expiresIn } };
    },
    {
      sessionAuth: true,
      body: IframeCodeRequestSchema,
      response: {
        200: IframeCodeResponseSchema,
        401: WebErrSchema,
        422: WebErrSchema,
      },
      detail: {
        tags: ["Workflow V2"],
        summary: "签发画布一次性 code",
        description:
          "请求体 { workflowId, view? }，返回 { code, expiresIn }。身份取自会话上下文，body 不接受 userId/orgId；" +
          "code 绑定 user + org + workflow，默认 60 秒有效、单次消费，由画布在 /workflow-canvas/bff/session/exchange 兑换票据。",
      },
    },
  );

  return app;
}
