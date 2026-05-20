import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { InstanceInfoSchema, SpawnInstanceFromEnvironmentRequestSchema } from "../../schemas/instance.schema";
import { getOwnedEnvironment } from "../../services/environment-core";
import type { SpawnedInstance } from "../../services/instance";
import { listInstances, spawnInstanceFromEnvironment, stopInstance } from "../../services/instance";
import { loadOrgContext } from "../../services/org-context";

const app = new Elysia({ name: "web-instances", prefix: "/web" }).use(authGuardPlugin).model({
  "instance-info": InstanceInfoSchema,
  "instance-info-list": InstanceInfoSchema.array(),
  "spawn-instance-request": SpawnInstanceFromEnvironmentRequestSchema,
});

function toResponse(inst: SpawnedInstance) {
  return {
    id: inst.id,
    port: inst.port,
    status: inst.status,
    error: inst.error,
    group_id: inst.apiKey,
    environment_id: inst.environmentId ?? null,
    session_id: inst.sessionId ?? null,
    instance_number: inst.instanceNumber,
    created_at: Math.floor(inst.createdAt.getTime() / 1000),
  };
}

app.post(
  "/instances/from-environment",
  async ({ store, body, error, request }: any) => {
    const user = store.user!;
    const authCtx = (await loadOrgContext(user, request))!;
    const b = body as { environmentId: string };
    if (!b.environmentId) {
      return error(400, { error: { type: "VALIDATION_ERROR", message: "environmentId is required" } });
    }
    // 验证 environment 归属当前团队
    await getOwnedEnvironment(b.environmentId, authCtx.organizationId);
    try {
      const inst = await spawnInstanceFromEnvironment(user.id, b.environmentId);
      return toResponse(inst);
    } catch (err: any) {
      const status =
        err.code === "NOT_FOUND"
          ? 404
          : err.code === "FORBIDDEN"
            ? 403
            : err.code === "VALIDATION_ERROR"
              ? 400
              : err.code === "MAX_SESSIONS_REACHED"
                ? 409
                : 500;
      return error(status, { error: { type: err.code ?? "spawn_failed", message: err.message } });
    }
  },
  { sessionAuth: true, body: "spawn-instance-request" },
);

app.get(
  "/instances",
  async ({ store, request }: any) => {
    const authCtx = (await loadOrgContext(store.user!, request))!;
    const insts = listInstances(authCtx.organizationId);
    return insts.map(toResponse);
  },
  { sessionAuth: true, response: "instance-info-list" },
);

app.delete(
  "/instances/:id",
  async ({ store, params, error, request }) => {
    const user = store.user!;
    const authCtx = (await loadOrgContext(user, request))!;
    const id = params.id;
    const result = await stopInstance(id, authCtx.organizationId);
    if (!result.ok) {
      const statusCode = result.error === "Instance not found" ? 404 : result.error === "Not your instance" ? 403 : 400;
      return error(statusCode, { error: { type: "bad_request", message: result.error } });
    }
    return { ok: true as const };
  },
  { sessionAuth: true },
);

export default app;
