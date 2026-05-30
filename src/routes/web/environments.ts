import Elysia from "elysia";
import { ValidationError as AppValidationError } from "../../errors";
import { authGuardPlugin } from "../../plugins/auth";
import {
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
import { enterEnvironment, spawnInstanceFromEnvironment } from "../../services/instance";

const app = new Elysia({ name: "web-environments" }).use(authGuardPlugin).model({
  "environment-info": EnvironmentInfoSchema,
  "environment-list-response": EnvironmentListResponseSchema,
  "update-environment-request": UpdateEnvironmentRequestSchema,
  "enter-environment-request": EnterEnvironmentRequestSchema,
});

/** GET /web/environments — List environments for the current team */
app.get(
  "/environments",
  async ({ store }) => {
    const authCtx = store.authContext!;
    return listEnvironmentsWithInstances(authCtx.organizationId);
  },
  { sessionAuth: true },
);

/** POST /web/environments — Register a new environment */
app.post(
  "/environments",
  async ({ store, body, error }) => {
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
        .then(() => console.log(`[RCS] Auto-started instance for new environment: ${record.name}`))
        .catch((err: unknown) => console.error(`[RCS] Failed to auto-start instance for ${record.name}:`, err));
    }

    return { ...sanitizeResponse(record), secret: record.secret };
  },
  { sessionAuth: true },
);

/** GET /web/environments/:id — Get environment detail (with secret) */
app.get(
  "/environments/:id",
  async ({ store, params, error }) => {
    const authCtx = store.authContext!;
    try {
      const env = await getOwnedEnvironment(params.id, authCtx.organizationId);
      return { ...sanitizeResponse(env), secret: env.secret };
    } catch (err: unknown) {
      if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
        return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      throw err;
    }
  },
  { sessionAuth: true },
);

/** PUT /web/environments/:id — Update environment metadata */
app.put(
  "/environments/:id",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    const b = body as {
      name?: string;
      description?: string | null;
      agentConfigId?: string | null;
      autoStart?: boolean;
    };

    let updated: Awaited<ReturnType<typeof updateWebEnvironment>>;
    try {
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
  { sessionAuth: true, body: "update-environment-request" },
);

/** POST /web/environments/:id/enter — Enter an environment */
app.post(
  "/environments/:id/enter",
  async ({ store, params, body, error }) => {
    const user = store.user!;
    const authCtx = store.authContext!;
    try {
      await getOwnedEnvironment(params.id, authCtx.organizationId);
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
  { sessionAuth: true, body: "enter-environment-request" },
);

/** DELETE /web/environments/:id — Delete environment */
app.delete(
  "/environments/:id",
  async ({ store, params, error }) => {
    const authCtx = store.authContext!;
    try {
      await getOwnedEnvironment(params.id, authCtx.organizationId);
    } catch (err: unknown) {
      if (err instanceof Error && (err as { code?: string }).code === "NOT_FOUND")
        return error(404, { error: { type: "NOT_FOUND", message: err.message } });
      throw err;
    }
    await deleteEnvironment(params.id);
    return { ok: true as const };
  },
  { sessionAuth: true },
);

export default app;
