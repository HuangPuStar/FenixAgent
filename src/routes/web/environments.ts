import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo, sessionRepo } from "../../repositories";
import type { EnvironmentRecord } from "../../repositories";
import { deleteEnvironment } from "../../services/environment";
import * as configPg from "../../services/config-pg";
import {
    spawnInstanceFromEnvironment,
    listInstancesByEnvironment,
    getRunningInstancesByEnvironment,
} from "../../services/instance";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
    EnvironmentInfoSchema,
    EnvironmentListResponseSchema,
    CreateEnvironmentRequestSchema,
    UpdateEnvironmentRequestSchema,
    EnterEnvironmentRequestSchema,
} from "../../schemas/environment.schema";

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
    const envs = await environmentRepo.listByUserId(user.id);
    const results = [];
    for (const env of envs) {
      let sessions = await sessionRepo.listByEnvironment(env.id);
      if (sessions.length === 0) {
        const session = await sessionRepo.create({
          environmentId: env.id,
          title: env.agentName || env.name,
          source: "acp",
          userId: user.id,
        });
        sessions = [session];
      }
      const activeInstances = listInstancesByEnvironment(env.id);
      const firstInstance = activeInstances[0];
      results.push({
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
      });
    }
    return results;
}, { sessionAuth: true });

/** POST /web/environments — Register a new environment */
app.post("/environments", async ({ store, body, error }) => {
    const user = store.user!;
    const b = body as { name: string; description?: string; agentName?: string; autoStart?: boolean; workspacePath: string };
    const { name, description, agentName, autoStart } = b;
    let { workspacePath } = b;

    if (!name || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
        return error(400, {
            error: {
                type: "VALIDATION_ERROR",
                message: "name 必须为 kebab-case 格式（小写字母、数字、连字符）",
            },
        });
    }

    if (!workspacePath) {
        return error(400, {
            error: {
                type: "VALIDATION_ERROR",
                message: "workspacePath 为必填字段",
            },
        });
    }
    const pathError = validateWorkspacePath(workspacePath);
    if (pathError) {
        return error(400, { error: { type: "VALIDATION_ERROR", message: pathError } });
    }

    if (agentName) {
        const agent = await configPg.getAgentConfig(user.id, agentName);
        if (!agent) {
            return error(400, {
                error: {
                    type: "VALIDATION_ERROR",
                    message: `Agent '${agentName}' 不存在`,
                },
            });
        }
    }

    try {
        mkdirSync(workspacePath, { recursive: true });
        workspacePath = realpathSync(workspacePath);
    } catch (err: any) {
        return error(500, {
            error: {
                type: "CONFIG_WRITE_ERROR",
                message: `无法创建目录: ${err.message}`,
            },
        });
    }

    const secret = generateEnvSecret();
    let record;
    try {
        record = await environmentRepo.create({
            name,
            description,
            workspacePath,
            agentName,
            status: "idle",
            secret,
            userId: user.id,
            autoStart: autoStart === true,
        });
    } catch (err: any) {
        if (err.message?.includes("UNIQUE constraint failed") || err.message?.includes("unique") || err.message?.includes("duplicate")) {
            return error(409, {
                error: {
                    type: "VALIDATION_ERROR",
                    message: `环境名称 '${name}' 已存在`,
                },
            });
        }
        throw err;
    }

    if (autoStart && record.userId) {
        spawnInstanceFromEnvironment(record.userId, record.id)
            .then(() => console.log(`[RCS] Auto-started instance for new environment: ${record.name}`))
            .catch((err: any) => console.error(`[RCS] Failed to auto-start instance for ${record.name}: ${err.message}`));
    }

    return {
        ...sanitizeResponse(record),
        secret: record.secret,
    };
}, { sessionAuth: true, body: "create-environment-request" });

/** GET /web/environments/:id — Get environment detail (with secret) */
app.get("/environments/:id", async ({ store, params, error }) => {
    const user = store.user!;
    const envId = params.id;
    const env = await environmentRepo.getById(envId);
    if (!env || env.userId !== user.id) {
        return error(404, { error: { type: "NOT_FOUND", message: "环境不存在" } });
    }
    return { ...sanitizeResponse(env), secret: env.secret };
}, { sessionAuth: true });

/** PUT /web/environments/:id — Update environment metadata */
app.put("/environments/:id", async ({ store, params, body, error }) => {
    const user = store.user!;
    const envId = params.id;
    const env = await environmentRepo.getById(envId);
    if (!env || env.userId !== user.id) {
        return error(404, { error: { type: "NOT_FOUND", message: "环境不存在" } });
    }

    const b = body as { name?: string; description?: string | null; workspacePath?: string; agentName?: string | null; autoStart?: boolean };
    const patch: Partial<Pick<EnvironmentRecord, "name" | "description" | "workspacePath" | "agentName" | "autoStart">> = {};

    if (b.name !== undefined) {
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(b.name)) {
            return error(400, {
                error: { type: "VALIDATION_ERROR", message: "name 必须为 kebab-case 格式" },
            });
        }
        patch.name = b.name;
    }
    if (b.workspacePath !== undefined) {
        const pathError = validateWorkspacePath(b.workspacePath);
        if (pathError) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: pathError } });
        }
        mkdirSync(b.workspacePath, { recursive: true });
        patch.workspacePath = realpathSync(b.workspacePath);
    }
    if (b.agentName !== undefined) {
        if (b.agentName) {
            const agent = await configPg.getAgentConfig(user.id, b.agentName);
            if (!agent) {
                return error(400, {
                    error: { type: "VALIDATION_ERROR", message: `Agent '${b.agentName}' 不存在` },
                });
            }
        }
        patch.agentName = b.agentName ?? null;
    }
    if (b.description !== undefined) {
        patch.description = b.description;
    }
    if (b.autoStart !== undefined) {
        patch.autoStart = !!b.autoStart;
    }

    await environmentRepo.update(envId, patch);
    const updated = await environmentRepo.getById(envId);
    return sanitizeResponse(updated!);
}, { sessionAuth: true, body: "update-environment-request" });

/** POST /web/environments/:id/enter — Enter an environment (auto-spawn instance if needed) */
app.post("/environments/:id/enter", async ({ store, params, body, error }) => {
    const user = store.user!;
    const envId = params.id;
    const env = await environmentRepo.getById(envId);
    if (!env || env.userId !== user.id) {
        return error(404, { error: { type: "NOT_FOUND", message: "环境不存在" } });
    }

    const b = body as { instance_number?: number };

    let inst: import("../../services/instance").SpawnedInstance | undefined;

    if (b.instance_number !== undefined) {
      const runningInstances = getRunningInstancesByEnvironment(envId);
      inst = runningInstances.find((i) => i.instanceNumber === b.instance_number);
      if (!inst) {
        return error(404, { error: { type: "NOT_FOUND", message: `实例 ${b.instance_number} 不存在或未运行` } });
      }
    } else {
      const runningInstances = getRunningInstancesByEnvironment(envId);
      if (runningInstances.length > 0) {
        inst = runningInstances[0];
      } else {
        try {
          inst = await spawnInstanceFromEnvironment(user.id, envId);
        } catch (err: any) {
          return error(500, { error: { type: "CONFIG_WRITE_ERROR", message: err.message } });
        }
      }
    }

    if (!inst) {
        return error(500, { error: { type: "CONFIG_WRITE_ERROR", message: "无法创建实例" } });
    }

    let sessionId = inst.sessionId;
    if (!sessionId) {
        const sessions = await sessionRepo.listByEnvironment(envId);
        sessionId = sessions.length > 0 ? sessions[0].id : undefined;
    }
    if (!sessionId) {
        const session = await sessionRepo.create({
            environmentId: envId,
            title: env.agentName || env.name,
            source: "acp",
            userId: user.id,
        });
        sessionId = session.id;
    }

    return {
        session_id: sessionId,
        instance_id: inst.id,
        instance_number: inst.instanceNumber,
        instance_status: inst.status,
        environment_id: envId,
    };
}, { sessionAuth: true, body: "enter-environment-request" });

/** GET /web/environments/:id/instances — List active instances for an environment */
app.get("/environments/:id/instances", async ({ store, params, error }) => {
    const user = store.user!;
    const envId = params.id;
    const env = await environmentRepo.getById(envId);
    if (!env || env.userId !== user.id) {
        return error(404, { error: { type: "NOT_FOUND", message: "环境不存在" } });
    }

    const activeInstances = listInstancesByEnvironment(envId);
    return {
        environment_id: envId,
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
app.delete("/environments/:id", async ({ store, params, error }) => {
    const user = store.user!;
    const envId = params.id;
    const env = await environmentRepo.getById(envId);
    if (!env || env.userId !== user.id) {
        return error(404, { error: { type: "NOT_FOUND", message: "环境不存在" } });
    }
    await deleteEnvironment(envId);
    return { ok: true as const };
}, { sessionAuth: true });

export default app;
