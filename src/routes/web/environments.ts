import { Hono } from "hono";
import { sessionAuth } from "../../auth/middleware";
import {
    storeCreateEnvironment,
    storeGetEnvironment,
    storeUpdateEnvironment,
    storeListEnvironmentsByUserId,
    storeDeleteEnvironment,
    storeListSessionsByEnvironment,
    storeCreateSession,
} from "../../store";
import type { EnvironmentRecord } from "../../store";
import { getSection } from "../../services/config";
import {
    spawnInstanceFromEnvironment,
    listInstancesByEnvironment,
    getRunningInstancesByEnvironment,
} from "../../services/instance";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";

function generateEnvSecret(): string {
    return `env_secret_${randomBytes(24).toString("hex")}`;
}

const BLOCKED_PATHS = [
    "/",
    "/etc",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/sys",
    "/proc",
    "/dev",
    "/boot",
    "/lib",
    "/root",
];

function validateWorkspacePath(p: string): string | null {
    if (!isAbsolute(p)) return "workspace 路径必须是绝对路径";
    const normalized = resolve(p);
    if (BLOCKED_PATHS.includes(normalized))
        return `不允许使用系统目录: ${normalized}`;
    for (const blocked of BLOCKED_PATHS) {
        if (blocked !== "/" && normalized.startsWith(blocked + "/")) {
            return `不允许使用系统目录下的路径: ${normalized}`;
        }
    }
    return null;
}

function sanitizeResponse(row: EnvironmentRecord) {
    return {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
        workspace_path: row.workspacePath,
        agent_name: row.agentName ?? null,
        status: row.status,
        machine_name: row.machineName ?? null,
        branch: row.branch ?? null,
        auto_start: row.autoStart ?? false,
        last_poll_at: row.lastPollAt
            ? Math.floor(new Date(row.lastPollAt).getTime() / 1000)
            : null,
        created_at: Math.floor(new Date(row.createdAt).getTime() / 1000),
        updated_at: Math.floor(new Date(row.updatedAt).getTime() / 1000),
    };
}

const app = new Hono();

/** GET /web/environments — List environments for the current user */
app.get("/environments", sessionAuth, async (c) => {
    const user = c.get("user")!;
    const envs = storeListEnvironmentsByUserId(user.id);
    return c.json(envs.map((env) => {
      // Ensure a session exists for each environment
      let sessions = storeListSessionsByEnvironment(env.id);
      if (sessions.length === 0) {
        const session = storeCreateSession({
          environmentId: env.id,
          title: env.agentName || env.name,
          source: "acp",
          userId: user.id,
        });
        sessions = [session];
      }
      // Get active instances for this environment
      const activeInstances = listInstancesByEnvironment(env.id);
      const firstInstance = activeInstances[0];
      return {
        ...sanitizeResponse(env),
        session_id: sessions[0].id,
        instance_status: firstInstance ? firstInstance.status : null,
        instance_id: firstInstance ? firstInstance.id : null,
        instances: activeInstances.map((inst) => ({
          id: inst.id,
          instance_number: inst.instanceNumber,
          status: inst.status,
          session_id: inst.sessionId ?? null,
          port: inst.port,
          created_at: Math.floor(inst.createdAt.getTime() / 1000),
        })),
        instances_count: activeInstances.length,
      };
    }), 200);
});

/** POST /web/environments — Register a new environment */
app.post("/environments", sessionAuth, async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json();
    const { name, description, agentName, autoStart } = body;
    let { workspacePath } = body;

    if (!name || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
        return c.json(
            {
                error: {
                    type: "VALIDATION_ERROR",
                    message:
                        "name 必须为 kebab-case 格式（小写字母、数字、连字符）",
                },
            },
            400,
        );
    }

    if (!workspacePath) {
        return c.json(
            {
                error: {
                    type: "VALIDATION_ERROR",
                    message: "workspacePath 为必填字段",
                },
            },
            400,
        );
    }
    const pathError = validateWorkspacePath(workspacePath);
    if (pathError) {
        return c.json(
            { error: { type: "VALIDATION_ERROR", message: pathError } },
            400,
        );
    }

    if (agentName) {
        const agents =
            (await getSection<Record<string, unknown>>("agent")) ?? {};
        if (!(agentName in agents)) {
            return c.json(
                {
                    error: {
                        type: "VALIDATION_ERROR",
                        message: `Agent '${agentName}' 不存在`,
                    },
                },
                400,
            );
        }
    }

    try {
        mkdirSync(workspacePath, { recursive: true });
        workspacePath = realpathSync(workspacePath);
    } catch (err: any) {
        return c.json(
            {
                error: {
                    type: "CONFIG_WRITE_ERROR",
                    message: `无法创建目录: ${err.message}`,
                },
            },
            500,
        );
    }

    const secret = generateEnvSecret();
    let record;
    try {
        record = storeCreateEnvironment({
            name,
            description: description ?? null,
            workspacePath,
            agentName: agentName ?? null,
            status: "idle",
            secret,
            userId: user.id,
            autoStart: autoStart === true,
        });
    } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint failed")) {
            return c.json(
                {
                    error: {
                        type: "VALIDATION_ERROR",
                        message: `环境名称 '${name}' 已存在`,
                    },
                },
                409,
            );
        }
        throw err;
    }

    // Auto-start instance in background if requested
    if (autoStart && record.userId) {
        spawnInstanceFromEnvironment(record.userId, record.id)
            .then(() => console.log(`[RCS] Auto-started instance for new environment: ${record.name}`))
            .catch((err: any) => console.error(`[RCS] Failed to auto-start instance for ${record.name}: ${err.message}`));
    }

    return c.json(
        {
            ...sanitizeResponse(record),
            secret: record.secret,
        },
        201,
    );
});

/** GET /web/environments/:id — Get environment detail (with secret) */
app.get("/environments/:id", sessionAuth, async (c) => {
    const user = c.get("user")!;
    const envId = c.req.param("id")!;
    const env = storeGetEnvironment(envId);
    if (!env || env.userId !== user.id) {
        return c.json(
            { error: { type: "NOT_FOUND", message: "环境不存在" } },
            404,
        );
    }
    return c.json({ ...sanitizeResponse(env), secret: env.secret }, 200);
});

/** PUT /web/environments/:id — Update environment metadata */
app.put("/environments/:id", sessionAuth, async (c) => {
    const user = c.get("user")!;
    const envId = c.req.param("id")!;
    const env = storeGetEnvironment(envId);
    if (!env || env.userId !== user.id) {
        return c.json(
            { error: { type: "NOT_FOUND", message: "环境不存在" } },
            404,
        );
    }

    const body = await c.req.json();
    const patch: Partial<Pick<EnvironmentRecord, "name" | "description" | "workspacePath" | "agentName" | "autoStart">> = {};

    if (body.name !== undefined) {
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(body.name)) {
            return c.json(
                {
                    error: {
                        type: "VALIDATION_ERROR",
                        message: "name 必须为 kebab-case 格式",
                    },
                },
                400,
            );
        }
        patch.name = body.name;
    }
    if (body.workspacePath !== undefined) {
        const pathError = validateWorkspacePath(body.workspacePath);
        if (pathError) {
            return c.json(
                { error: { type: "VALIDATION_ERROR", message: pathError } },
                400,
            );
        }
        mkdirSync(body.workspacePath, { recursive: true });
        patch.workspacePath = realpathSync(body.workspacePath);
    }
    if (body.agentName !== undefined) {
        if (body.agentName) {
            const agents =
                (await getSection<Record<string, unknown>>("agent")) ?? {};
            if (!(body.agentName in agents)) {
                return c.json(
                    {
                        error: {
                            type: "VALIDATION_ERROR",
                            message: `Agent '${body.agentName}' 不存在`,
                        },
                    },
                    400,
                );
            }
        }
        patch.agentName = body.agentName || null;
    }
    if (body.description !== undefined) {
        patch.description = body.description;
    }
    if (body.autoStart !== undefined) {
        patch.autoStart = !!body.autoStart;
    }

    storeUpdateEnvironment(envId, patch);
    const updated = storeGetEnvironment(envId);
    return c.json(sanitizeResponse(updated!), 200);
});

/** POST /web/environments/:id/enter — Enter an environment (auto-spawn instance if needed) */
app.post("/environments/:id/enter", sessionAuth, async (c) => {
    const user = c.get("user")!;
    const envId = c.req.param("id")!;
    const env = storeGetEnvironment(envId);
    if (!env || env.userId !== user.id) {
        return c.json(
            { error: { type: "NOT_FOUND", message: "环境不存在" } },
            404,
        );
    }

    let body: any = {};
    try { body = await c.req.json(); } catch { /* empty body is ok */ }
    const instanceNumber = body.instance_number as number | undefined;

    let inst: import("../../services/instance").SpawnedInstance | undefined;

    if (instanceNumber !== undefined) {
      // Find instance by number
      const runningInstances = getRunningInstancesByEnvironment(envId);
      inst = runningInstances.find((i) => i.instanceNumber === instanceNumber);
      if (!inst) {
        return c.json(
          { error: { type: "NOT_FOUND", message: `实例 ${instanceNumber} 不存在或未运行` } },
          404,
        );
      }
    } else {
      // Default: find or spawn first running instance
      const runningInstances = getRunningInstancesByEnvironment(envId);
      if (runningInstances.length > 0) {
        inst = runningInstances[0];
      } else {
        try {
          inst = await spawnInstanceFromEnvironment(user.id, envId);
        } catch (err: any) {
          return c.json(
            { error: { type: "CONFIG_WRITE_ERROR", message: err.message } },
            500,
          );
        }
      }
    }

    if (!inst) {
        return c.json(
            { error: { type: "CONFIG_WRITE_ERROR", message: "无法创建实例" } },
            500,
        );
    }

    // Ensure session exists
    let sessionId = inst.sessionId;
    if (!sessionId) {
        const sessions = storeListSessionsByEnvironment(envId);
        sessionId = sessions.length > 0 ? sessions[0].id : undefined;
    }
    if (!sessionId) {
        const session = storeCreateSession({
            environmentId: envId,
            title: env.agentName || env.name,
            source: "acp",
            userId: user.id,
        });
        sessionId = session.id;
    }

    return c.json({
        session_id: sessionId,
        instance_id: inst.id,
        instance_number: inst.instanceNumber,
        instance_status: inst.status,
        environment_id: envId,
    }, 200);
});

/** GET /web/environments/:id/instances — List active instances for an environment */
app.get("/environments/:id/instances", sessionAuth, async (c) => {
    const user = c.get("user")!;
    const envId = c.req.param("id")!;
    const env = storeGetEnvironment(envId);
    if (!env || env.userId !== user.id) {
        return c.json(
            { error: { type: "NOT_FOUND", message: "环境不存在" } },
            404,
        );
    }

    const activeInstances = listInstancesByEnvironment(envId);
    return c.json({
        environment_id: envId,
        instances: activeInstances.map((inst) => ({
          id: inst.id,
          instance_number: inst.instanceNumber,
          status: inst.status,
          session_id: inst.sessionId ?? null,
          port: inst.port,
          created_at: Math.floor(inst.createdAt.getTime() / 1000),
        })),
    }, 200);
});

/** DELETE /web/environments/:id — Delete environment */
app.delete("/environments/:id", sessionAuth, async (c) => {
    const user = c.get("user")!;
    const envId = c.req.param("id")!;
    const env = storeGetEnvironment(envId);
    if (!env || env.userId !== user.id) {
        return c.json(
            { error: { type: "NOT_FOUND", message: "环境不存在" } },
            404,
        );
    }
    storeDeleteEnvironment(envId);
    return c.json({ ok: true }, 200);
});

export default app;
