import Elysia from "elysia";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import { requireOrgScope } from "../../plugins/require-team-scope";
import { environmentRepo } from "../../repositories";
import { updatePollTime } from "../../services/environment";
import { ackWork, heartbeatWork, pollWork, stopWork } from "../../services/work-dispatch";

const app = new Elysia({ name: "v1-environments-work", prefix: "/v1/environments" }).use(authGuardPlugin);

/** 校验目标 environment 属于当前认证 team */
async function requireEnvOwnership(
  authContext: AuthContext | null,
  envId: string,
  error: (code: number, body: unknown) => Response,
): Promise<Response | undefined> {
  const env = await environmentRepo.getById(envId);
  if (!env) {
    return error(404, { error: { type: "not_found", message: "Environment not found" } });
  }
  const denied = requireOrgScope(authContext, env.organizationId);
  if (denied) return denied;
  return;
}

/** GET /v1/environments/:id/work/poll — Long-poll for work */
app.get(
  "/:id/work/poll",
  async ({ store, params, set, error }) => {
    const denied = await requireEnvOwnership(store.authContext, params.id, error);
    if (denied) return denied;

    const envId = params.id;
    await updatePollTime(envId);
    const result = await pollWork(envId);
    if (!result) {
      set.status = 204;
      return null;
    }
    return result;
  },
  { apiKeyAuth: true },
);

/** POST /v1/environments/:id/work/:workId/ack — Acknowledge work */
app.post(
  "/:id/work/:workId/ack",
  async ({ store, params, error }) => {
    const denied = await requireEnvOwnership(store.authContext, params.id, error);
    if (denied) return denied;

    const workId = params.workId;
    ackWork(workId);
    return { status: "ok" };
  },
  { apiKeyAuth: true },
);

/** POST /v1/environments/:id/work/:workId/stop — Stop work */
app.post(
  "/:id/work/:workId/stop",
  async ({ store, params, error }) => {
    const denied = await requireEnvOwnership(store.authContext, params.id, error);
    if (denied) return denied;

    const workId = params.workId;
    stopWork(workId);
    return { status: "ok" };
  },
  { apiKeyAuth: true },
);

/** POST /v1/environments/:id/work/:workId/heartbeat — Heartbeat */
app.post(
  "/:id/work/:workId/heartbeat",
  async ({ store, params, error }) => {
    const denied = await requireEnvOwnership(store.authContext, params.id, error);
    if (denied) return denied;

    const workId = params.workId;
    const result = heartbeatWork(workId);
    return result;
  },
  { apiKeyAuth: true },
);

export default app;
