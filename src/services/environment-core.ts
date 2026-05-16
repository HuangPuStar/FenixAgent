import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { environmentRepo } from "../repositories";
import type { EnvironmentResponse } from "../types/api";
import type { EnvironmentRecord } from "../repositories";
import { NotFoundError } from "../errors";

const BLOCKED_PATHS = [
  "/", "/etc", "/usr", "/bin", "/sbin", "/var", "/sys", "/proc",
  "/dev", "/boot", "/lib", "/root",
];

/** 校验 workspace 路径是否安全（不在系统目录下） */
export function validateWorkspacePath(p: string): string | null {
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

/** 确保 workspace 目录存在，返回真实路径 */
export function ensureWorkspaceDir(workspacePath: string): string {
  mkdirSync(workspacePath, { recursive: true });
  return realpathSync(workspacePath);
}

/** kebab-case 格式校验正则 */
export const KEBAB_CASE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** 生成 Web 控制面板环境 secret（env_secret_ 前缀） */
export function generateEnvSecret(): string {
  return `env_secret_${randomBytes(24).toString("hex")}`;
}

/** 将 EnvironmentRecord 转为 v1 格式响应 */
export function toResponse(row: EnvironmentRecord): EnvironmentResponse {
  return {
    id: row.id,
    machine_name: row.machineName,
    directory: row.directory,
    branch: row.branch,
    status: row.status,
    username: row.username,
    last_poll_at: row.lastPollAt ? Math.floor(row.lastPollAt.getTime() / 1000) : null,
    worker_type: row.workerType,
    capabilities: row.capabilities,
  };
}

/** 将 EnvironmentRecord 转为 Web 控制面板 API 响应格式 */
export function sanitizeResponse(row: EnvironmentRecord) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    workspace_path: row.workspacePath,
    agent_name: row.agentName ?? null,
    agent_config_id: row.agentConfigId ?? null,
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

/** 获取 Environment 并验证归属，未找到或不属于该用户时抛出 NotFoundError */
export async function getOwnedEnvironment(envId: string, userId: string) {
  const env = await environmentRepo.getById(envId);
  if (!env || env.userId !== userId) {
    throw new NotFoundError("环境不存在");
  }
  return env;
}

/** 删除 environment */
export async function deleteEnvironment(envId: string): Promise<boolean> {
  return environmentRepo.delete(envId);
}

/** Web 控制面板创建 Environment 的参数 */
export interface CreateWebEnvironmentParams {
  name: string;
  description?: string;
  agentConfigId?: string;
  workspacePath: string;
  autoStart?: boolean;
  userId: string;
}

/** Web 控制面板更新 Environment 的参数 */
export interface UpdateWebEnvironmentParams {
  name?: string;
  description?: string | null;
  workspacePath?: string;
  agentConfigId?: string | null;
  autoStart?: boolean;
}
