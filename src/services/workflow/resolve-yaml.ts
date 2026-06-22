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
  // 优先使用直接传入的 yaml
  const yaml = payload.yaml as string | undefined;
  if (yaml) return yaml;

  const workflowId = payload.workflowId as string | undefined;
  if (!workflowId) return null;

  // 确定目标版本：显式指定 > latestVersion 回退 > 0（草稿）
  let targetVersion: number;
  if (payload.version !== undefined) {
    targetVersion = payload.version as number;
  } else {
    const wf = await deps.getWorkflowDef(workflowId, organizationId);
    if (!wf) {
      logger.warn(`resolveYaml: workflow not found for workflowId=${workflowId}`);
      return null;
    }
    targetVersion = wf.latestVersion ?? 0;
  }

  const resolved = await deps.getVersionYaml(workflowId, targetVersion, undefined);
  if (!resolved) {
    logger.warn(`resolveYaml: no yaml found for workflowId=${workflowId} version=${targetVersion}`);
  }
  return resolved;
}
