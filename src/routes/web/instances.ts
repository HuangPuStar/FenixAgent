import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { spawnInstance, listInstances, stopInstance, spawnInstanceFromEnvironment } from "../../services/instance";
import type { SpawnedInstance } from "../../services/instance";
import {
  InstanceInfoSchema,
  SpawnInstanceFromEnvironmentRequestSchema,
} from "../../schemas/instance.schema";

const app = new Elysia({ name: "web-instances", prefix: "/web" })
  .use(authGuardPlugin)
  .model({
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

app.post("/instances", async ({ store, error }) => {
  const user = store.user!;
  try {
    const inst = await spawnInstance(user.id);
    return toResponse(inst);
  } catch (err: any) {
    return error(500, { error: { type: "spawn_failed", message: err.message } });
  }
}, { sessionAuth: true });

app.post("/instances/from-environment", async ({ store, body, error }) => {
  const user = store.user!;
  const b = body as { environmentId: string };
  if (!b.environmentId) {
    return error(400, { error: { type: "VALIDATION_ERROR", message: "environmentId is required" } });
  }
  try {
    const inst = await spawnInstanceFromEnvironment(user.id, b.environmentId);
    return toResponse(inst);
  } catch (err: any) {
    const status = err.message === "Environment not found" ? 404
      : err.message === "Not your environment" ? 403
      : err.message.startsWith("Workspace directory does not exist") ? 400
      : 500;
    return error(status, { error: { type: "spawn_failed", message: err.message } });
  }
}, { sessionAuth: true, body: "spawn-instance-request" });

app.get("/instances", ({ store }) => {
  const user = store.user!;
  const insts = listInstances(user.id);
  return insts.map(toResponse);
}, { sessionAuth: true, response: "instance-info-list" });

app.delete("/instances/:id", async ({ store, params, error }) => {
  const user = store.user!;
  const id = params.id;
  const result = await stopInstance(id, user.id);
  if (!result.ok) {
    const statusCode = result.error === "Instance not found" ? 404
      : result.error === "Not your instance" ? 403
      : 400;
    return error(statusCode, { error: { type: "bad_request", message: result.error } });
  }
  return { ok: true as const };
}, { sessionAuth: true });

export default app;
