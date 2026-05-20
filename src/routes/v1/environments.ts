import Elysia from "elysia";
import { NotFoundError } from "../../errors";
import { authGuardPlugin } from "../../plugins/auth";
import { requireOrgScope } from "../../plugins/require-team-scope";
import { environmentRepo } from "../../repositories";
import { type BridgeRegistrationRequest, BridgeRegistrationRequestSchema } from "../../schemas/v1-environment.schema";
import { deregisterBridge, reconnectBridge, registerBridge } from "../../services/environment";

const app = new Elysia({ name: "v1-environments", prefix: "/v1/environments" }).use(authGuardPlugin).model({
  "bridge-registration-request": BridgeRegistrationRequestSchema,
});

/** POST /v1/environments/bridge — REST registration for acp-link compatibility */
app.post(
  "/bridge",
  async ({ store, body, error }) => {
    const user = store.user!;
    const authContext = store.authContext;
    const b = body as BridgeRegistrationRequest;
    const authEnvId = store.authEnvironmentId as string | undefined;

    return registerBridge({
      authEnvironmentId: authEnvId,
      userId: user.id,
      organizationId: authContext?.organizationId,
      machine_name: b.machine_name,
      directory: b.directory,
      branch: b.branch,
      git_repo_url: b.git_repo_url,
      max_sessions: b.max_sessions,
      worker_type: b.worker_type,
      capabilities: b.capabilities,
      metadata: b.metadata,
    });
  },
  { apiKeyAuth: true, body: "bridge-registration-request" },
);

/** DELETE /v1/environments/bridge/:id — Deregister */
app.delete(
  "/bridge/:id",
  async ({ store, params, error }) => {
    const user = store.user!;
    const authContext = store.authContext;

    const env = await environmentRepo.getById(params.id);
    if (!env) {
      return error(404, { error: { type: "not_found", message: "Environment not found" } });
    }
    const denied = requireOrgScope(authContext, env.organizationId);
    if (denied) return denied;

    try {
      await deregisterBridge(params.id, user.id);
      return { status: "ok" };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return error(404, { error: { type: "not_found", message: "Environment not found" } });
      }
      throw err;
    }
  },
  { apiKeyAuth: true },
);

/** POST /v1/environments/:id/bridge/reconnect — Reconnect */
app.post(
  "/:id/bridge/reconnect",
  async ({ store, params, error }) => {
    const user = store.user!;
    const authContext = store.authContext;

    const env = await environmentRepo.getById(params.id);
    if (!env) {
      return error(404, { error: { type: "not_found", message: "Environment not found" } });
    }
    const denied = requireOrgScope(authContext, env.organizationId);
    if (denied) return denied;

    try {
      await reconnectBridge(params.id, user.id);
      return { status: "ok" };
    } catch (err) {
      if (err instanceof NotFoundError) {
        return error(404, { error: { type: "not_found", message: "Environment not found" } });
      }
      throw err;
    }
  },
  { apiKeyAuth: true },
);

export default app;
