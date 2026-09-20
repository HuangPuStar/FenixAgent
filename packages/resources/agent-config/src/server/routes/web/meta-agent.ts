/**
 * Meta Agent 路由工厂：`POST /web/meta-agent/ensure`（任务 1.5c 从宿主
 * `apps/server/src/routes/web/meta-agent.ts` 迁入）。
 *
 * 归属：查找或创建 meta environment + spawn 实例的编排（`ensureMetaEnvironment`）与响应 schema 本就在本包，
 * 宿主那份只是协议接入壳；迁入后协议定义、编排与响应形状同址。
 *
 * 两项依赖由宿主注入：**守卫**是 Elysia 实例作用域的认证状态（理由见 `../dependencies`）；
 * **`rotateCallerApiKey`** 因为「同名 key 只保留一把」的编排只在身份侧实现一处，而资源包不得依赖
 * `@fenix/identity`（ce-ee-engineering-standards §2.3），见 `../../services/meta-agent` 的类型注释。
 */

import { createLogger } from "@fenix/logger";
import { WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { EnsureMetaAgentResponseSchema } from "../../schemas/meta-agent.schema";
import { ensureMetaEnvironment } from "../../services/meta-agent";
import type { WebMetaAgentRouteDependencies } from "../dependencies";

const logger = createLogger("meta-agent");

/** 构造 `/web/meta-agent/ensure` 路由。 */
export function createWebMetaAgentRoutes(deps: WebMetaAgentRouteDependencies) {
  const app = new Elysia({ name: "web-meta-agent" }).use(deps.authGuardPlugin).model({
    "ensure-meta-agent-response": EnsureMetaAgentResponseSchema,
  });

  app.post(
    "/meta-agent/ensure",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
    async ({ store, request, error }: any) => {
      const authCtx = store.authContext!;
      if (!authCtx) {
        return error(401, { success: false, error: { code: "UNAUTHORIZED", message: "No organization context" } });
      }

      try {
        const result = await ensureMetaEnvironment(authCtx, request, {
          rotateCallerApiKey: deps.rotateCallerApiKey,
        });
        return { success: true, data: result };
      } catch (err: unknown) {
        logger.error("ensure failed:", err);
        return error(500, {
          success: false,
          error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        });
      }
    },
    {
      sessionAuth: true,
      response: {
        200: "ensure-meta-agent-response",
        401: WebErrSchema,
        500: WebErrSchema,
      },
      detail: {
        tags: ["Meta Agent"],
        summary: "确保 Meta Agent 可用",
        description: "查找或创建 Meta Agent 对应的环境，并尽可能拉起一个可用实例。",
      },
    },
  );

  return app;
}
