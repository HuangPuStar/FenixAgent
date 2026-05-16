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
  listInstancesByEnvironment,
  getRunningInstancesByEnvironment,
  ensureRunning,
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
  const b = body as { name: string; description?: string; agentName?: string; agentConfigId?: string; autoStart?: boolean; workspacePath: string };

  const record = await createWebEnvironment({
    name: b.name,
    description: b.description,
    agentName: b.agentName,
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
  const b = body as { name?: string; description?: string | null; workspacePath?: string; agentName?: string | null; agentConfigId?: string | null; autoStart?: boolean };

  const updated = await updateWebEnvironment(params.id, user.id, {
    name: b.name,
    description: b.description,
    workspacePath: b.workspacePath,
    agentName: b.agentName,
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
  let inst: import("../../services/instance").SpawnedInstance | undefined;

  if (b.instance_number !== undefined) {
    const runningInstances = getRunningInstancesByEnvironment(params.id);
    inst = runningInstances.find((i) => i.instanceNumber === b.instance_number);
    if (!inst) {
      return error(404, { error: { type: "NOT_FOUND", message: `实例 ${b.instance_number} 不存在或未运行` } });
    }
  } else {
    try {
      const result = await ensureRunning(user.id, params.id);
      inst = result.instance;
    } catch (err: any) {
      return error(500, { error: { type: "CONFIG_WRITE_ERROR", message: err.message } });
    }
  }

  if (!inst) {
    return error(500, { error: { type: "CONFIG_WRITE_ERROR", message: "无法创建实例" } });
  }

  return {
    session_id: inst.sessionId ?? null,
    instance_id: inst.id,
    instance_number: inst.instanceNumber,
    instance_status: inst.status,
    environment_id: params.id,
  };
}, { sessionAuth: true, body: "enter-environment-request" });

/** GET /web/environments/:id/instances — List active instances for an environment */
app.get("/environments/:id/instances", async ({ store, params }) => {
  const user = store.user!;
  await getOwnedEnvironment(params.id, user.id);

  const activeInstances = listInstancesByEnvironment(params.id);
  return {
    environment_id: params.id,
    instances: activeInstances.map((inst) => ({
      id: inst.id,
      instance_number: inst.instanceNumber,
      status: inst.status,
      session_id: inst.sessionId ?? null,
      port: inst.port,
      created_at: Math.floor(inst.createdAt.getTime() / 1000),
    })),
  };
}, { sessionAuth: true });

/** DELETE /web/environments/:id — Delete environment */
app.delete("/environments/:id", async ({ store, params }) => {
  const user = store.user!;
  await getOwnedEnvironment(params.id, user.id);
  await deleteEnvironment(params.id);
  return { ok: true as const };
}, { sessionAuth: true });

export default app;
