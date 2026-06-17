import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { ValidationError as AppValidationError } from "../../errors";
import { authGuardPlugin } from "../../plugins/auth";
import {
  CreateEnvironmentRequestSchema,
  CreateEnvironmentResponseSchema,
  DeleteEnvironmentResponseSchema,
  EnterEnvironmentRequestSchema,
  EnterEnvironmentResponseSchema,
  EnvironmentDetailResponseSchema,
  EnvironmentInfoSchema,
  EnvironmentListResponseSchema,
  EnvironmentListSchema,
  ListInstancesResponseSchema,
  UpdateEnvironmentRequestSchema,
  UpdateEnvironmentResponseSchema,
} from "../../schemas/environment.schema";
import {
  createWebEnvironment,
  deleteEnvironment,
  getOwnedEnvironment,
  listEnvironmentsWithInstances,
  sanitizeResponse,
  updateWebEnvironment,
} from "../../services/environment";
import { enterEnvironment, listInstancesResponse, spawnInstanceFromEnvironment } from "../../services/instance";

const logger = createLogger("env-route");

const app = new Elysia({ name: "web-environments" }).use(authGuardPlugin).model({
  "create-environment-request": CreateEnvironmentRequestSchema,
  "create-environment-response": CreateEnvironmentResponseSchema,
  "delete-environment-response": DeleteEnvironmentResponseSchema,
  "enter-environment-response": EnterEnvironmentResponseSchema,
  "environment-detail-response": EnvironmentDetailResponseSchema,
  "environment-info": EnvironmentInfoSchema,
  "environment-instances-response": ListInstancesResponseSchema,
  "environment-list": EnvironmentListSchema,
  "environment-list-response": EnvironmentListResponseSchema,
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
    // 始终按当前用户视角过滤：绑定 agent 的 runtime env 按 userId 隔离，
    // 未绑 agent 的手动环境仍组织内可见，避免前端把他人 runtime 挂到自己的 agent 上。
    return listEnvironmentsWithInstances(authCtx.organizationId, user.id);
  },
  {
    sessionAuth: true,
    response: "environment-list",
    detail: {
      tags: ["Environments"],
      summary: "获取环境列表",
      description: "返回当前组织下的环境列表，并附带每个环境的活跃实例摘要。绑定 agent 的 runtime 环境按当前用户隔离。",
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
      agentConfigId?: string;
      autoStart?: boolean;
    };

    let record: Awaited<ReturnType<typeof createWebEnvironment>>;
    try {
      record = await createWebEnvironment({
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
        return error(400, { error: { type: "VALIDATION_ERROR", message: (err as Error).message } });
      }
      throw err;
    }

    if (b.autoStart && record.userId) {
      spawnInstanceFromEnvironment(record.userId, record.id)
        .then(() => logger.info(`Auto-started instance for new environment: ${record.name}`))
        .catch((err: unknown) => logger.error(`Failed to auto-start instance for ${record.name}:`, err));
    }

    return { ...sanitizeResponse(record), secret: record.secret };
  },
  {
    sessionAuth: true,
    body: "create-environment-request",
    response: "create-environment-response",
    detail: {
      tags: ["Environments"],
      summary: "创建环境",
      description: "创建一个新的环境，并可选绑定 Agent 配置与自动启动选项。",
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
      const env = await getOwnedEnvironment(params.id, authCtx.organizationId, user.id);
      return { ...sanitizeResponse(env), secret: env.secret };
    } catch (err: unknown) {
      if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
        return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      throw err;
    }
  },
  {
    sessionAuth: true,
    response: "environment-detail-response",
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
      agentConfigId?: string | null;
      autoStart?: boolean;
    };

    let updated: Awaited<ReturnType<typeof updateWebEnvironment>>;
    try {
      await getOwnedEnvironment(params.id, authCtx.organizationId, user.id);
      updated = await updateWebEnvironment(params.id, authCtx.organizationId, {
        name: b.name,
        description: b.description,
        agentConfigId: b.agentConfigId,
        autoStart: b.autoStart,
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
        return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      if (
        err instanceof AppValidationError ||
        (err instanceof Error && "code" in err && (err as { code?: string }).code === "VALIDATION_ERROR")
      ) {
        return error(400, { error: { type: "VALIDATION_ERROR", message: err.message } });
      }
      throw err;
    }
    return sanitizeResponse(updated!);
  },
  {
    sessionAuth: true,
    body: "update-environment-request",
    response: "update-environment-response",
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
      await getOwnedEnvironment(params.id, authCtx.organizationId, user.id);
    } catch (err: unknown) {
      if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
        return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      throw err;
    }

    const b = body as { instance_number?: number };
    try {
      return await enterEnvironment(user.id, params.id, b.instance_number);
    } catch (err: unknown) {
      if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND") {
        return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      }
      return error(500, { error: { type: "CONFIG_WRITE_ERROR", message: (err as Error).message } });
    }
  },
  {
    sessionAuth: true,
    body: "enter-environment-request",
    response: "enter-environment-response",
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
      await getOwnedEnvironment(params.id, authCtx.organizationId, user.id);
    } catch (err: unknown) {
      if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
        return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      throw err;
    }
    await deleteEnvironment(params.id);
    return { ok: true as const };
  },
  {
    sessionAuth: true,
    response: "delete-environment-response",
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
      await getOwnedEnvironment(params.id, authCtx.organizationId, user.id);
    } catch (err: unknown) {
      if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
        return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      throw err;
    }
    return listInstancesResponse(params.id);
  },
  {
    sessionAuth: true,
    response: "environment-instances-response",
    detail: {
      tags: ["Environments"],
      summary: "获取环境实例列表",
      description: "返回指定环境下当前活跃的实例列表。",
    },
  },
);

export default app;
