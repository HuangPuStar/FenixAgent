import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { InstanceInfoSchema, SpawnInstanceFromEnvironmentRequestSchema } from "../../schemas/instance.schema";
import { getOwnedEnvironment } from "../../services/environment-core";
import type { SpawnedInstance } from "../../services/instance";
import { listInstances, spawnInstanceFromEnvironment, stopInstance } from "../../services/instance";

const app = new Elysia({ name: "web-instances" }).use(authGuardPlugin).model({
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
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, error }: any) => {
    const user = store.user!;
    const authCtx = store.authContext!;
    const b = body as { environmentId: string };
    if (!b.environmentId) {
      return error(400, { error: { type: "VALIDATION_ERROR", message: "environmentId is required" } });
    }
    // 验证 environment 归属当前团队
    await getOwnedEnvironment(b.environmentId, authCtx.organizationId);
    try {
      const inst = await spawnInstanceFromEnvironment(user.id, b.environmentId);
      return toResponse(inst);
    } catch (err: unknown) {
      const code = err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "";
      const status =
        code === "NOT_FOUND"
          ? 404
          : code === "FORBIDDEN"
            ? 403
            : code === "VALIDATION_ERROR"
              ? 400
              : code === "MAX_SESSIONS_REACHED"
                ? 409
                : 500;
      return error(status, { error: { type: code || "spawn_failed", message: (err as Error).message } });
    }
  },
  { sessionAuth: true, body: "spawn-instance-request" },
);

app.get(
  "/instances",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, request: _request }: any) => {
    const authCtx = store.authContext!;
    const insts = listInstances(authCtx.organizationId);
    return insts.map(toResponse);
  },
  { sessionAuth: true, response: "instance-info-list" },
);

app.delete(
  "/instances/:id",
  async ({ store, params, error, request: _request }) => {
    const _user = store.user!;
    const authCtx = store.authContext!;
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
