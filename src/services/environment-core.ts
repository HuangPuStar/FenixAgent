import { randomBytes } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ForbiddenError, NotFoundError } from "../errors";
import type { EnvironmentRecord } from "../repositories";
import { environmentRepo } from "../repositories";
import type { EnvironmentResponse } from "../types/api";
import { stopInstancesForEnvironments } from "./orchestration-instance";

const BLOCKED_PATHS = ["/", "/etc", "/usr", "/bin", "/sbin", "/var", "/sys", "/proc", "/dev", "/boot", "/lib", "/root"];

/** 校验 workspace 路径是否安全（不在系统目录下） */
export function validateWorkspacePath(p: string): string | null {
  if (!isAbsolute(p)) return "workspace 路径必须是绝对路径";
  const normalized = resolve(p);
  if (BLOCKED_PATHS.includes(normalized)) return `不允许使用系统目录: ${normalized}`;
  for (const blocked of BLOCKED_PATHS) {
    if (blocked !== "/" && normalized.startsWith(`${blocked}/`)) {
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
    directory: row.workspacePath,
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
    agent_config_id: row.agentConfigId ?? null,
    status: row.status,
    machine_name: row.machineName ?? null,
    branch: row.branch ?? null,
    auto_start: row.autoStart ?? false,
    last_poll_at: row.lastPollAt ? Math.floor(row.lastPollAt.getTime() / 1000) : null,
    created_at: Math.floor(row.createdAt.getTime() / 1000),
    updated_at: Math.floor(row.updatedAt.getTime() / 1000),
  };
}

/** 组织成员角色（与 authContext.role 取值一致） */
export type EnvironmentRole = "owner" | "admin" | "member";

/**
 * 获取 Environment 并验证可见性与操作角色（D17 角色化授权：403/404 分离）。
 *
 * 普通共享 environment 仍按组织可见；绑定 agent 的 runtime environment 额外要求访问者是 owner，
 * 避免共享 agent 时直接落到其他成员的个人 workspace。
 *
 * role 参数语义（语义变更点）：调用方声明本次为「需要 owner/admin 权限的写操作」。
 * role 为 member 时抛 ForbiddenError（403，环境存在但无操作权限）；owner/admin 或不传
 * （读操作）放行。环境不存在/组织不可见/agent 绑定环境非本人 → NotFoundError（404），
 * 与 403 明确区分，避免向未授权调用方泄露环境是否存在。
 * 现状注意：W5a 文件门面（agent-file-service.ensureEnvironment）对全部操作透传 role 属
 * 中间态——member 经文件门面的操作一律 403（fail-closed，比「只读」更保守），若需精确
 * 的读写分离由后续波次在调用点区分，本函数签名保持四参数不变。
 */
export async function getOwnedEnvironment(
  envId: string,
  organizationId: string,
  userId?: string,
  role?: EnvironmentRole,
) {
  const env = await environmentRepo.getById(envId);
  if (!env || env.organizationId !== organizationId) {
    throw new NotFoundError("环境不存在");
  }
  if (userId && env.agentConfigId && env.userId !== userId) {
    throw new NotFoundError("环境不存在");
  }
  if (role === "member") {
    throw new ForbiddenError("无权限执行该操作");
  }
  return env;
}

/**
 * 删除 environment。
 *
 * 删除前先停止该 environment 上的运行实例：删 DB 只移记录，不停止编排实例会泄漏
 * Agent 进程与并发额度（见 docs/issues/2026-08-19-agent-delete-instance-leak.md）。
 * 不传 organizationId：所有调用方（web DELETE 已校验归属、ACP deregister/disconnect
 * 已校验归属）均在此前完成权限校验，环境内实例必然同属该环境。
 */
export async function deleteEnvironment(envId: string): Promise<boolean> {
  await stopInstancesForEnvironments([envId]);
  return environmentRepo.delete(envId);
}

/** Web 控制面板创建 Environment 的参数 */
export interface CreateWebEnvironmentParams {
  name: string;
  description?: string;
  agentConfigId: string;
  workspacePath?: string;
  autoStart?: boolean;
  userId: string;
  organizationId?: string;
}

/** Web 控制面板更新 Environment 的参数 */
export interface UpdateWebEnvironmentParams {
  name?: string;
  description?: string | null;
  agentConfigId?: string;
  autoStart?: boolean;
}
