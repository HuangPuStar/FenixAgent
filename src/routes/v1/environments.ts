import { Hono } from "hono";
import { apiKeyAuth } from "../../auth/middleware";
import {
  storeCreateEnvironment,
  storeCreateSession,
  storeDeleteEnvironment,
  storeFindEnvironmentByMachineName,
  storeGetEnvironment,
  storeUpdateEnvironment,
  storeListSessionsByEnvironment,
} from "../../store";

const app = new Hono();

/** POST /v1/environments/bridge — REST registration for acp-link compatibility */
app.post("/bridge", apiKeyAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{
    machine_name?: string;
    directory?: string;
    branch?: string;
    git_repo_url?: string;
    max_sessions?: number;
    worker_type?: string;
    bridge_id?: string;
    capabilities?: Record<string, unknown>;
    metadata?: { worker_type?: string };
  }>();

  const workerType = body.worker_type || body.metadata?.worker_type || "acp";

  // Reuse existing offline record if available (same machineName + userId)
  let record = body.machine_name
    ? storeFindEnvironmentByMachineName(body.machine_name, user.id)
    : undefined;

  if (record && record.status === "offline") {
    storeUpdateEnvironment(record.id, {
      status: "active",
      capabilities: body.capabilities || record.capabilities || undefined,
      maxSessions: body.max_sessions ?? record.maxSessions,
    });
  } else {
    record = storeCreateEnvironment({
      secret: `rest_${Date.now()}`,
      userId: user.id,
      machineName: body.machine_name,
      directory: body.directory,
      branch: body.branch,
      gitRepoUrl: body.git_repo_url,
      maxSessions: body.max_sessions,
      workerType,
      capabilities: body.capabilities,
    });
  }

  let sessionId: string | undefined;
  if (workerType === "acp") {
    const existing = storeListSessionsByEnvironment(record.id);
    if (existing.length > 0) {
      sessionId = existing[0].id;
    } else {
      const session = storeCreateSession({
        environmentId: record.id,
        title: body.machine_name || "ACP Agent",
        source: "acp",
        userId: user.id,
      });
      sessionId = session.id;
    }
  }

  return c.json({
    environment_id: record.id,
    environment_secret: record.secret,
    status: record.status,
    session_id: sessionId,
  }, 200);
});

/** DELETE /v1/environments/bridge/:id — Deregister */
app.delete("/bridge/:id", apiKeyAuth, async (c) => {
  const user = c.get("user")!;
  const envId = c.req.param("id")!;
  const env = storeGetEnvironment(envId);
  if (!env || env.userId !== user.id) {
    return c.json({ error: { type: "not_found", message: "Environment not found" } }, 404);
  }
  storeDeleteEnvironment(envId);
  return c.json({ status: "ok" }, 200);
});

/** POST /v1/environments/:id/bridge/reconnect — Reconnect */
app.post("/:id/bridge/reconnect", apiKeyAuth, async (c) => {
  const user = c.get("user")!;
  const envId = c.req.param("id")!;
  const env = storeGetEnvironment(envId);
  if (!env || env.userId !== user.id) {
    return c.json({ error: { type: "not_found", message: "Environment not found" } }, 404);
  }
  storeUpdateEnvironment(envId, { status: "active" });
  return c.json({ status: "ok" }, 200);
});

export default app;
