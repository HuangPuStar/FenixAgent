import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  createWebEnvironment,
  updateWebEnvironment,
  getOwnedEnvironment,
  deleteEnvironment,
  sanitizeResponse,
  listEnvironmentsWithInstances,
} from "../../services/environment";
import {
  spawnInstanceFromEnvironment,
  enterEnvironment,
  listInstancesResponse,
} from "../../services/instance";
import {
  EnvironmentInfoSchema,
  EnvironmentListResponseSchema,
  CreateEnvironmentRequestSchema,
  UpdateEnvironmentRequestSchema,
  EnterEnvironmentRequestSchema,
} from "../../schemas/environment.schema";

const app = new Elysia({ name: "web-environments", prefix: "/web" })
  .use(authGuardPlugin)
  .model({
    "environment-info": EnvironmentInfoSchema,
    "environment-list-response": EnvironmentListResponseSchema,
    "create-environment-request": CreateEnvironmentRequestSchema,
    "update-environment-request": UpdateEnvironmentRequestSchema,
    "enter-environment-request": EnterEnvironmentRequestSchema,
  });

/** GET /web/environments — List environments for the current user */
app.get("/environments", async ({ store }) => {
  const user = store.user!;
  return listEnvironmentsWithInstances(user.id);
}, { sessionAuth: true });

/** POST /web/environments — Register a new environment */
app.post("/environments", async ({ store, body }) => {
  const user = store.user!;
  const b = body as { name: string; description?: string; agentConfigId?: string; autoStart?: boolean; workspacePath: string };

  const record = await createWebEnvironment({
    name: b.name,
    description: b.description,
    agentConfigId: b.agentConfigId,
    workspacePath: b.workspacePath,
    autoStart: b.autoStart,
    userId: user.id,
  });

  if (b.autoStart && record.userId) {
    spawnInstanceFromEnvironment(record.userId, record.id)
      .then(() => console.log(`[RCS] Auto-started instance for new environment: ${record.name}`))
      .catch((err: any) => console.error(`[RCS] Failed to auto-start instance for ${record.name}: ${err.message}`));
  }

  return { ...sanitizeResponse(record), secret: record.secret };
}, { sessionAuth: true, body: "create-environment-request" });

/** GET /web/environments/:id — Get environment detail (with secret) */
app.get("/environments/:id", async ({ store, params }) => {
  const user = store.user!;
  const env = await getOwnedEnvironment(params.id, user.id);
  return { ...sanitizeResponse(env), secret: env.secret };
}, { sessionAuth: true });

/** PUT /web/environments/:id — Update environment metadata */
app.put("/environments/:id", async ({ store, params, body }) => {
  const user = store.user!;
  const b = body as { name?: string; description?: string | null; workspacePath?: string; agentConfigId?: string | null; autoStart?: boolean };

  const updated = await updateWebEnvironment(params.id, user.id, {
    name: b.name,
    description: b.description,
    workspacePath: b.workspacePath,
    agentConfigId: b.agentConfigId,
    autoStart: b.autoStart,
  });
  return sanitizeResponse(updated!);
}, { sessionAuth: true, body: "update-environment-request" });

/** POST /web/environments/:id/enter — Enter an environment */
app.post("/environments/:id/enter", async ({ store, params, body, error }) => {
  const user = store.user!;
  await getOwnedEnvironment(params.id, user.id);

  const b = body as { instance_number?: number };
  try {
    return await enterEnvironment(user.id, params.id, b.instance_number);
  } catch (err: any) {
    if (err.code === "NOT_FOUND") {
      return error(404, { error: { type: "NOT_FOUND", message: err.message } });
    }
    return error(500, { error: { type: "CONFIG_WRITE_ERROR", message: err.message } });
  }
}, { sessionAuth: true, body: "enter-environment-request" });

/** GET /web/environments/:id/instances — List active instances for an environment */
app.get("/environments/:id/instances", async ({ store, params }) => {
  const user = store.user!;
  await getOwnedEnvironment(params.id, user.id);
  return listInstancesResponse(params.id);
}, { sessionAuth: true });

/** DELETE /web/environments/:id — Delete environment */
app.delete("/environments/:id", async ({ store, params }) => {
  const user = store.user!;
  await getOwnedEnvironment(params.id, user.id);
  await deleteEnvironment(params.id);
  return { ok: true as const };
}, { sessionAuth: true });

export default app;
