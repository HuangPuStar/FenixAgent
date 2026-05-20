import Elysia from "elysia";
import { ValidationError as AppValidationError } from "../../errors";
import { authGuardPlugin } from "../../plugins/auth";
import {
  CreateEnvironmentRequestSchema,
  EnterEnvironmentRequestSchema,
  EnvironmentInfoSchema,
  EnvironmentListResponseSchema,
  UpdateEnvironmentRequestSchema,
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
const app = new Elysia({ name: "web-environments", prefix: "/web" }).use(authGuardPlugin).model({
  "environment-info": EnvironmentInfoSchema,
  "environment-list-response": EnvironmentListResponseSchema,
  "create-environment-request": CreateEnvironmentRequestSchema,
  "update-environment-request": UpdateEnvironmentRequestSchema,
  "enter-environment-request": EnterEnvironmentRequestSchema,
});

/** GET /web/environments — List environments for the current team */
app.get(
  "/environments",
  async ({ store, request }) => {
    const authCtx = store.authContext!;
    return listEnvironmentsWithInstances(authCtx.organizationId);
  },
  { sessionAuth: true },
);

/** POST /web/environments — Register a new environment */
app.post(
  "/environments",
  async ({ store, body, request, error }) => {
    const user = store.user!;
    const authCtx = store.authContext!;
    const b = body as {
      name: string;
      description?: string;
      agentConfigId?: string;
      autoStart?: boolean;
      workspacePath: string;
    };

    let record;
    try {
      record = await createWebEnvironment({
        name: b.name,
        description: b.description,
        agentConfigId: b.agentConfigId,
        workspacePath: b.workspacePath,
        autoStart: b.autoStart,
        userId: user.id,
        organizationId: authCtx.organizationId,
      });
    } catch (err: any) {
      if (err instanceof AppValidationError || err.code === "VALIDATION_ERROR") {
        return error(400, { error: { type: "VALIDATION_ERROR", message: err.message } });
      }
      throw err;
    }

    if (b.autoStart && record.userId) {
      spawnInstanceFromEnvironment(record.userId, record.id)
        .then(() => console.log(`[RCS] Auto-started instance for new environment: ${record.name}`))
        .catch((err: any) => console.error(`[RCS] Failed to auto-start instance for ${record.name}: ${err.message}`));
    }

    return { ...sanitizeResponse(record), secret: record.secret };
  },
  { sessionAuth: true, body: "create-environment-request" },
);

/** GET /web/environments/:id — Get environment detail (with secret) */
app.get(
  "/environments/:id",
  async ({ store, params, request, error }) => {
    const authCtx = store.authContext!;
    try {
      const env = await getOwnedEnvironment(params.id, authCtx.organizationId);
      return { ...sanitizeResponse(env), secret: env.secret };
    } catch (err: any) {
      if (err.code === "NOT_FOUND") return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      throw err;
    }
  },
  { sessionAuth: true },
);

/** PUT /web/environments/:id — Update environment metadata */
app.put(
  "/environments/:id",
  async ({ store, params, body, request, error }) => {
    const authCtx = store.authContext!;
    const b = body as {
      name?: string;
      description?: string | null;
      workspacePath?: string;
      agentConfigId?: string | null;
      autoStart?: boolean;
    };

    let updated;
    try {
      updated = await updateWebEnvironment(params.id, authCtx.organizationId, {
        name: b.name,
        description: b.description,
        workspacePath: b.workspacePath,
        agentConfigId: b.agentConfigId,
        autoStart: b.autoStart,
      });
    } catch (err: any) {
      if (err.code === "NOT_FOUND") return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      if (err instanceof AppValidationError || err.code === "VALIDATION_ERROR") {
        return error(400, { error: { type: "VALIDATION_ERROR", message: err.message } });
      }
      throw err;
    }
    return sanitizeResponse(updated!);
  },
  { sessionAuth: true, body: "update-environment-request" },
);

/** POST /web/environments/:id/enter — Enter an environment */
app.post(
  "/environments/:id/enter",
  async ({ store, params, body, error, request }) => {
    const user = store.user!;
    const authCtx = store.authContext!;
    try {
      await getOwnedEnvironment(params.id, authCtx.organizationId);
    } catch (err: any) {
      if (err.code === "NOT_FOUND") return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      throw err;
    }

    const b = body as { instance_number?: number };
    try {
      return await enterEnvironment(user.id, params.id, b.instance_number);
    } catch (err: any) {
      if (err.code === "NOT_FOUND") {
        return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      }
      return error(500, { error: { type: "CONFIG_WRITE_ERROR", message: err.message } });
    }
  },
  { sessionAuth: true, body: "enter-environment-request" },
);

/** GET /web/environments/:id/instances — List active instances for an environment */
app.get(
  "/environments/:id/instances",
  async ({ store, params, request, error }) => {
    const authCtx = store.authContext!;
    try {
      await getOwnedEnvironment(params.id, authCtx.organizationId);
    } catch (err: any) {
      if (err.code === "NOT_FOUND") return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      throw err;
    }
    return listInstancesResponse(params.id);
  },
  { sessionAuth: true },
);

/** DELETE /web/environments/:id — Delete environment */
app.delete(
  "/environments/:id",
  async ({ store, params, request, error }) => {
    const authCtx = store.authContext!;
    try {
      await getOwnedEnvironment(params.id, authCtx.organizationId);
    } catch (err: any) {
      if (err.code === "NOT_FOUND") return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      throw err;
    }
    await deleteEnvironment(params.id);
    return { ok: true as const };
  },
  { sessionAuth: true },
);

export default app;
