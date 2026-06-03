import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { DeleteInstanceResponseSchema, SpawnInstanceFromEnvironmentRequestSchema } from "../../schemas/instance.schema";
import { getCoreRuntime } from "../../services/core-bootstrap";
import { getOwnedEnvironment } from "../../services/environment";
import { spawnInstanceFromEnvironment, stopInstance } from "../../services/instance";

const app = new Elysia({ name: "web-instances" }).use(authGuardPlugin).model({
  "spawn-instance-request": SpawnInstanceFromEnvironmentRequestSchema,
  "delete-instance-response": DeleteInstanceResponseSchema,
});

/** POST /web/instances/from-environment — 为环境启动新实例 */
app.post(
  "/instances/from-environment",
  async ({ store, body, error }) => {
    const user = store.user!;
    const authCtx = store.authContext!;
    const b = body as { environmentId: string };

    try {
      await getOwnedEnvironment(b.environmentId, authCtx.organizationId);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "NOT_FOUND") {
        return error(404, { error: { type: "NOT_FOUND", message: (err as Error).message } });
      }
      throw err;
    }

    const instance = await spawnInstanceFromEnvironment(user.id, b.environmentId);
    return { success: true as const, data: instance };
  },
  { sessionAuth: true, body: "spawn-instance-request" },
);

/** DELETE /web/instances/:id — 停止并删除实例 */
app.delete(
  "/instances/:id",
  async ({ store, params, error }) => {
    const authCtx = store.authContext!;
    const result = await stopInstance(params.id, authCtx.organizationId);

    if (!result.ok) {
      const isAlreadyStopped = result.error === "Already stopped";
      if (isAlreadyStopped) {
        getCoreRuntime().deleteInstance(params.id);
        return { success: true as const, data: { ok: true as const } };
      }
      const status = result.error === "Instance not found" ? 404 : 403;
      const type = status === 404 ? "NOT_FOUND" : "forbidden";
      return error(status, { error: { type, message: result.error! } });
    }

    getCoreRuntime().deleteInstance(params.id);
    return { success: true as const, data: { ok: true as const } };
  },
  { sessionAuth: true },
);

export default app;
