/**
 * Workflow YAML 解析服务。
 *
 * 从请求 payload 中解析要执行/校验的 YAML 内容。
 * 优先级：直接传入的 yaml > 通过 workflowId + version 从存储读取。
 * 未指定 version 时默认使用最新发布版本（latestVersion ?? 0）。
 */
import { createLogger } from "@fenix/logger";
import type {
  getVersionYaml as GetVersionYaml,
  getWorkflowDef as GetWorkflowDef,
} from "../../repositories/workflow-def";

const logger = createLogger("wf-resolve-yaml");

/** resolveYaml 依赖的外部函数（依赖注入，便于测试） */
export interface ResolveYamlDeps {
  getWorkflowDef: typeof GetWorkflowDef;
  getVersionYaml: typeof GetVersionYaml;
}

/**
 * 从 payload 解析 YAML。
 * @returns 解析出的 YAML 字符串，或 null（无 yaml 且无 workflowId / workflow 不存在 / 版本 YAML 缺失）
 */
export async function resolveYaml(
  payload: Record<string, unknown>,
  organizationId: string,
  deps: ResolveYamlDeps,
): Promise<string | null> {
  const workflowId = payload.workflowId as string | undefined;
  const yaml = payload.yaml as string | undefined;

  // workflowId 同时也是 SSE 事件隔离键；即使直接传 YAML，也必须先校验其属于当前组织。
  const workflow = workflowId ? await deps.getWorkflowDef(workflowId, organizationId) : null;
  if (workflowId && !workflow) {
    logger.warn(`resolveYaml: workflow not found for workflowId=${workflowId}`);
    return null;
  }
  if (yaml) return yaml;
  if (!workflowId || !workflow) return null;

  // 确定目标版本：显式指定 > latestVersion 回退 > 0（草稿）
  const targetVersion = payload.version !== undefined ? (payload.version as number) : (workflow.latestVersion ?? 0);
  const storagePath = workflow.storagePath;

  const resolved = await deps.getVersionYaml(workflowId, targetVersion, { organizationId, storagePath });
  if (!resolved) {
    logger.warn(`resolveYaml: no yaml found for workflowId=${workflowId} version=${targetVersion}`);
  }
  return resolved;
}
