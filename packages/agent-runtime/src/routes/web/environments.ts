/**
 * 控制台环境路由工厂：`/web/environments/**`（1.5c 从宿主 `apps/server/src/routes/web/environments.ts` 迁入）。
 *
 * 归属：环境的 owner 是本包（`environmentRepo` / `services/environment-*` / 运行编排），路由只做协议接入。
 *
 * 取数方式：环境与实例的运行能力一律经 `getBoundAgentRuntime()`（相对导入 `../../runtime`）取，判据与
 * `routes/web/instances.ts` 相同——这些能力都在 `AgentRuntimePort` 上，而 port 是宿主编排层与用例的
 * **唯一替换点**（`stubAgentRuntimePort`）。直引包内模块函数等于给同一批能力开第二个替换点（1.4 W3b
 * 收敛掉的形态）；取绑定入口不会产生第二套状态，因为 `createAgentRuntime()` 内部持有的都是本包模块级单例。
 *
 * 守卫由宿主注入（与 `/api/instances`、`/acp/*`、`/web/sessions/*`、`/web/instances/*` 同因）：Elysia 的
 * `macro` / `state` 是实例作用域的，包内自建一份会让同一进程出现两套互不可见的认证状态。
 *
 * 迁出时的口径调整：原文件末尾的 `export default createEnvironmentRoutes()` 改为只导出工厂——宿主是唯一
 * 的挂载方，default 自执行会在任何导入方（含测试的 `mock.module` 转发表）都构造一份路由实例。
 */

import { createLogger } from "@fenix/logger";
import { OrchestrationError } from "@fenix/orchestration";
import { ValidationError as AppValidationError, WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { SandboxProviderNotConfiguredError, SandboxRuntimeNotReadyError } from "@fenix/resource-sandbox/server";
import Elysia from "elysia";
import * as z from "zod/v4";
import { mapOrchestrationErrorToHttp } from "../../errors/orchestration-http";
import { type EnvironmentRecord, getBoundAgentRuntime } from "../../runtime";
import {
  CreateEnvironmentRequestSchema,
  CreateEnvironmentResponseSchema,
  EnterEnvironmentRequestSchema,
  EnterEnvironmentResponseSchema,
  EnvironmentDetailEnvelopeSchema,
  EnvironmentInfoSchema,
  EnvironmentListEnvelopeSchema,
  EnvironmentListSchema,
  ListInstancesResponseSchema,
  UpdateEnvironmentRequestSchema,
  UpdateEnvironmentResponseSchema,
} from "../../schemas/environment.schema";
import { sanitizeResponse } from "../../services/environment-core";
import type { AgentRuntimeAuthDependencies } from "../dependencies";

const logger = createLogger("env-route");

/**
 * 构造 `/web/environments/**` 路由。
 *
 * 环境与实例的运行能力经运行 port 取（1.4 W3b）：路由不自持一份可替换的 deps 袋子——那等于给同一批
 * 能力开第二个替换点，用例要替换运行能力时改绑 port 即可。
 */
export function createWebEnvironmentsRoutes(deps: AgentRuntimeAuthDependencies) {
  const app = new Elysia({ name: "web-environments" }).use(deps.authGuardPlugin).model({
    "create-environment-request": CreateEnvironmentRequestSchema,
    "create-environment-response": CreateEnvironmentResponseSchema,
    "delete-environment-response": WebOkSchema(z.null()).describe("删除环境后的成功响应。"),
    "enter-environment-response": EnterEnvironmentResponseSchema,
    "environment-detail-response": EnvironmentDetailEnvelopeSchema,
    "environment-info": EnvironmentInfoSchema,
    "environment-instances-response": ListInstancesResponseSchema,
    "environment-list": EnvironmentListSchema,
    "environment-list-response": EnvironmentListEnvelopeSchema,
    "update-environment-request": UpdateEnvironmentRequestSchema,
    "update-environment-response": UpdateEnvironmentResponseSchema,
    "enter-environment-request": EnterEnvironmentRequestSchema,
  });

  /** GET /web/environments — List environments for the current team */
  app.get(
    "/environments",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store }: any) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      // 环境现在统一要求绑定 agentConfig；列表按当前用户视角过滤 runtime env，
      // 避免前端把其他成员的 runtime 误挂到自己的 agent 上。
      return {
        success: true as const,
        data: await getBoundAgentRuntime().listEnvironments(authCtx.organizationId, user.id),
      };
    },
    {
      sessionAuth: true,
      response: "environment-list-response",
      detail: {
        tags: ["Environments"],
        summary: "获取环境列表",
        description:
          "返回当前组织下已绑定 Agent 配置的环境列表，并附带每个环境的活跃实例摘要。运行时环境按当前用户隔离。",
      },
    },
  );

  /** POST /web/environments — Register a new environment */
  app.post(
    "/environments",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, body, error }: any) => {
      const user = store.user!;
      const authCtx = store.authContext!;
      const b = body as {
        name: string;
        description?: string;
        agentConfigId: string;
        autoStart?: boolean;
      };

      let record: EnvironmentRecord;
      try {
        record = await getBoundAgentRuntime().createEnvironment({
          name: b.name,
          description: b.description,
          agentConfigId: b.agentConfigId,
          autoStart: b.autoStart,
          userId: user.id,
          organizationId: authCtx.organizationId,
        });
      } catch (err: unknown) {
        if (
          err instanceof AppValidationError ||
          (err instanceof Error && "code" in err && (err as { code?: string }).code === "VALIDATION_ERROR")
        ) {
          return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: (err as Error).message } });
        }
        throw err;
      }

      if (b.autoStart && record.userId) {
        const runtime = getBoundAgentRuntime();
        runtime
          .findOrCreateDefaultInstance(record.id, record.userId)
          .then((instance) => runtime.ensureInstanceRuntime(instance))
          .then(() => logger.info(`Auto-started instance for new environment: ${record.name}`))
          .catch((err: unknown) => logger.error(`Failed to auto-start instance for ${record.name}:`, err));
      }

      return { success: true as const, data: { ...sanitizeResponse(record), secret: record.secret } };
    },
    {
      sessionAuth: true,
      body: "create-environment-request",
      response: {
        200: "create-environment-response",
        400: WebErrSchema,
      },
      detail: {
        tags: ["Environments"],
        summary: "创建环境",
        description: "创建一个新的环境，必须绑定 Agent 配置，并可选开启自动启动。",
      },
    },
  );

  /** GET /web/environments/:id — Get environment detail (with secret) */
  app.get(
    "/environments/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, error }: any) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      try {
        const env = await getBoundAgentRuntime().getOwnedEnvironment(params.id, authCtx.organizationId, user.id);
        return { success: true as const, data: { ...sanitizeResponse(env), secret: env.secret } };
      } catch (err: unknown) {
        if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
          return error(404, { success: false, error: { code: "NOT_FOUND", message: err.message } });
        throw err;
      }
    },
    {
      sessionAuth: true,
      response: {
        200: "environment-detail-response",
        404: WebErrSchema,
      },
      detail: {
        tags: ["Environments"],
        summary: "获取环境详情",
        description: "根据环境 ID 返回环境详情，其中包含环境密钥等完整信息。",
      },
    },
  );

  /** PUT /web/environments/:id — Update environment metadata */
  app.put(
    "/environments/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, body, error }: any) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      const b = body as {
        name?: string;
        description?: string | null;
        agentConfigId?: string;
        autoStart?: boolean;
      };

      let updated: EnvironmentRecord;
      try {
        await getBoundAgentRuntime().getOwnedEnvironment(params.id, authCtx.organizationId, user.id);
        updated = await getBoundAgentRuntime().updateEnvironment(params.id, authCtx.organizationId, {
          name: b.name,
          description: b.description,
          agentConfigId: b.agentConfigId,
          autoStart: b.autoStart,
        });
      } catch (err: unknown) {
        if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
          return error(404, { success: false, error: { code: "NOT_FOUND", message: err.message } });
        if (
          err instanceof AppValidationError ||
          (err instanceof Error && "code" in err && (err as { code?: string }).code === "VALIDATION_ERROR")
        ) {
          return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: err.message } });
        }
        throw err;
      }
      return { success: true as const, data: sanitizeResponse(updated!) };
    },
    {
      sessionAuth: true,
      body: "update-environment-request",
      response: {
        200: "update-environment-response",
        400: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Environments"],
        summary: "更新环境",
        description: "更新环境名称、描述、绑定的 Agent 配置以及自动启动设置。",
      },
    },
  );

  /** POST /web/environments/:id/enter — Enter an environment */
  app.post(
    "/environments/:id/enter",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, body, error }: any) => {
      const user = store.user!;
      const authCtx = store.authContext!;
      try {
        await getBoundAgentRuntime().getOwnedEnvironment(params.id, authCtx.organizationId, user.id);
      } catch (err: unknown) {
        if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
          return error(404, { success: false, error: { code: "NOT_FOUND", message: err.message } });
        throw err;
      }

      const b = body as { instanceUid?: string };
      try {
        const instance = await getBoundAgentRuntime().ensureInstance({
          environmentId: params.id,
          ownerUserId: user.id,
          requestedInstanceUid: b.instanceUid,
          automaticSelection: "chat",
        });
        return {
          success: true as const,
          data: {
            instanceUid: instance.id,
            environmentId: instance.environmentId,
            name: instance.name,
            status: getBoundAgentRuntime().getRuntimeSnapshot(instance.id).state,
            createdAt: instance.createdAt.toISOString(),
          },
        };
      } catch (err: unknown) {
        if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND") {
          return error(404, { success: false, error: { code: "NOT_FOUND", message: err.message } });
        }
        // Sandbox 服务不可用（Provider 未配置 / Runtime 未就绪）→ 503；本路由有本地
        // catch 不冒泡 errorPlugin，必须在此处理。message 固定通用文案，不得泄漏
        // providerKey / sbi_* sandboxId（错误对象携带这些内部标识）。
        if (err instanceof SandboxProviderNotConfiguredError || err instanceof SandboxRuntimeNotReadyError) {
          return error(503, {
            success: false,
            error: { code: "SERVICE_UNAVAILABLE", message: "Sandbox service is unavailable" },
          });
        }
        if (err instanceof OrchestrationError) {
          const mapped = mapOrchestrationErrorToHttp(err);
          return error(mapped.status, {
            success: false,
            error: { code: err.code, message: mapped.message },
          });
        }
        return error(500, { success: false, error: { code: "CONFIG_WRITE_ERROR", message: (err as Error).message } });
      }
    },
    {
      sessionAuth: true,
      body: "enter-environment-request",
      response: {
        200: "enter-environment-response",
        404: WebErrSchema,
        500: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Environments"],
        summary: "进入环境",
        description: "为环境选择或拉起实例，并返回进入该环境所需的实例和会话信息。",
      },
    },
  );

  /** DELETE /web/environments/:id — Delete environment */
  app.delete(
    "/environments/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, error }: any) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      try {
        await getBoundAgentRuntime().getOwnedEnvironment(params.id, authCtx.organizationId, user.id);
      } catch (err: unknown) {
        if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
          return error(404, { success: false, error: { code: "NOT_FOUND", message: err.message } });
        throw err;
      }
      await getBoundAgentRuntime().deleteEnvironment(params.id);
      return { success: true as const, data: null };
    },
    {
      sessionAuth: true,
      response: {
        200: "delete-environment-response",
        404: WebErrSchema,
      },
      detail: {
        tags: ["Environments"],
        summary: "删除环境",
        description: "删除指定环境。删除前会先校验该环境是否属于当前组织。",
      },
    },
  );

  /** GET /web/environments/:id/instances — List instances for an environment */
  app.get(
    "/environments/:id/instances",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, error }: any) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      try {
        await getBoundAgentRuntime().getOwnedEnvironment(params.id, authCtx.organizationId, user.id);
      } catch (err: unknown) {
        if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
          return error(404, { success: false, error: { code: "NOT_FOUND", message: err.message } });
        throw err;
      }
      const instances = await getBoundAgentRuntime().listOwnedInstances(user.id, params.id);
      return {
        success: true as const,
        data: {
          environment_id: params.id,
          instances: instances.map((instance) => ({
            instanceUid: instance.id,
            name: instance.name,
            status: instance.runtime.state,
            createdAt: instance.createdAt.toISOString(),
          })),
        },
      };
    },
    {
      sessionAuth: true,
      response: {
        200: "environment-instances-response",
        404: WebErrSchema,
      },
      detail: {
        tags: ["Environments"],
        summary: "获取环境实例列表",
        description: "返回指定环境下当前活跃的实例列表。",
      },
    },
  );

  return app;
}
