import Elysia from "elysia";
import { randomBytes } from "node:crypto";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo, sessionRepo } from "../../repositories";
import { deleteEnvironment } from "../../services/environment";

const app = new Elysia({ name: "v1-environments", prefix: "/v1/environments" })
  .use(authGuardPlugin);

function generateBridgeSecret(): string {
  return `rest_${randomBytes(24).toString("hex")}`;
}

/** POST /v1/environments/bridge — REST registration for acp-link compatibility */
app.post("/bridge", async ({ store, body, error }) => {
  const user = store.user!;
  const b = (body as any) ?? {};

  // If authenticated via environment secret, return the existing environment
  const authEnvId = store.authEnvironmentId as string | undefined;
  if (authEnvId) {
    const existing = await environmentRepo.getById(authEnvId);
    if (existing) {
      await environmentRepo.update(authEnvId, {
        status: "active",
        lastPollAt: new Date(),
        capabilities: b.capabilities || undefined,
        maxSessions: b.max_sessions,
      });

      const sessions = await sessionRepo.listByEnvironment(authEnvId);
      return {
        environment_id: existing.id,
        environment_secret: existing.secret,
        status: "active",
        session_id: sessions.length > 0 ? sessions[0].id : undefined,
      };
    }
  }

  const workerType = b.worker_type || b.metadata?.worker_type || "acp";

  const record = await environmentRepo.create({
    secret: generateBridgeSecret(),
    userId: user.id,
    machineName: b.machine_name,
    directory: b.directory,
    branch: b.branch,
    gitRepoUrl: b.git_repo_url,
    maxSessions: b.max_sessions,
    workerType,
    capabilities: b.capabilities,
  });

  let sessionId: string | undefined;
  if (workerType === "acp") {
    const existing = await sessionRepo.listByEnvironment(record.id);
    if (existing.length > 0) {
      sessionId = existing[0].id;
    } else {
      const session = await sessionRepo.create({
        environmentId: record.id,
        title: b.machine_name || "ACP Agent",
        source: "acp",
        userId: user.id,
      });
      sessionId = session.id;
    }
  }

  return {
    environment_id: record.id,
    environment_secret: record.secret,
    status: record.status,
    session_id: sessionId,
  };
}, { apiKeyAuth: true });

/** DELETE /v1/environments/bridge/:id — Deregister */
app.delete("/bridge/:id", async ({ store, params, error }) => {
  const user = store.user!;
  const envId = params.id;
  const env = await environmentRepo.getById(envId);
  if (!env || env.userId !== user.id) {
    return error(404, { error: { type: "not_found", message: "Environment not found" } });
  }
  await deleteEnvironment(envId);
  return { status: "ok" };
}, { apiKeyAuth: true });

/** POST /v1/environments/:id/bridge/reconnect — Reconnect */
app.post("/:id/bridge/reconnect", async ({ store, params, error }) => {
  const user = store.user!;
  const envId = params.id;
  const env = await environmentRepo.getById(envId);
  if (!env || env.userId !== user.id) {
    return error(404, { error: { type: "not_found", message: "Environment not found" } });
  }
  await environmentRepo.update(envId, { status: "active" });
  return { status: "ok" };
}, { apiKeyAuth: true });

export default app;
