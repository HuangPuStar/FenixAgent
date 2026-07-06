/**
 * Workflow 外部 API 执行服务。
 *
 * 职责：
 * - 根据 workflowId + version 加载 YAML
 * - 调用 engine.runAsync() 启动执行
 * - 同步模式：等待 DAG 完成或超时，通过 engine.getOutput() 取 end 节点输出
 * - 异步模式：立即返回 runId
 */

import { createLogger } from "@fenix/logger";
import { WorkflowError } from "@fenix/workflow-engine";
import {
  getVersionYaml,
  getWorkflowDef,
  linkWorkflowSnapshotToWorkflow,
  resolveWorkflowExecutionVersion,
} from "../../repositories/workflow-def";
import type { ApiWorkflowExecuteRequestBody } from "../../schemas/api-workflow.schema";
import { cleanupSpawnedEnvironments, getTeamEngine } from "./index";
import { resolveYaml } from "./resolve-yaml";

const logger = createLogger("wf-execute");

export type WorkflowExecuteSuccessResult = {
  runId: string;
  status: "SUCCESS";
  version: number;
  output?: Record<string, unknown>;
  duration: number;
};

export type WorkflowExecuteFailedResult = {
  runId: string;
  status: "FAILED";
  version: number;
  error: { nodeId?: string; message: string };
  duration: number;
};

export type WorkflowExecuteTimeoutResult = {
  runId: string;
  status: "TIMEOUT";
  version: number;
  duration: number;
};

export type WorkflowExecuteSyncResult =
  | WorkflowExecuteSuccessResult
  | WorkflowExecuteFailedResult
  | WorkflowExecuteTimeoutResult;

export type WorkflowExecuteAsyncResult = {
  runId: string;
  version: number;
};

/** 解析本次执行实际使用的 workflow 版本号。 */
async function resolveExecutionVersion(
  workflowId: string,
  organizationId: string,
  requestedVersion: number | undefined,
): Promise<{ version: number }> {
  const resolved = await resolveWorkflowExecutionVersion(workflowId, organizationId, requestedVersion);
  if (!resolved) {
    throw new WorkflowError("Workflow YAML not found", "NOT_FOUND" as never);
  }
  return { version: resolved.version };
}

/**
 * 执行指定工作流并返回结果。
 */
export async function executeWorkflow(
  organizationId: string,
  workflowId: string,
  body: ApiWorkflowExecuteRequestBody,
): Promise<WorkflowExecuteSyncResult | WorkflowExecuteAsyncResult> {
  const engine = getTeamEngine(organizationId);

  const startTime = Date.now();

  // 先确定实际执行版本，响应中回传，避免调用方误以为草稿或其它版本已生效。
  const { version } = await resolveExecutionVersion(workflowId, organizationId, body.version);

  // 加载 YAML
  const yaml = await resolveYaml({ workflowId, version, params: body.inputs }, organizationId, {
    getWorkflowDef,
    getVersionYaml,
  });
  if (!yaml) {
    throw new WorkflowError("Workflow YAML not found", "NOT_FOUND" as never);
  }

  // 解析 YAML，找出 end 节点 ID（等 DAG 完成后直接用引擎取输出，不绕路查事件流）
  const def = engine.parse(yaml);
  const endNode = def.nodes.find((n) => n.type === "end");

  const { runId, result } = engine.runAsync(yaml, body.inputs);

  // 后台收尾
  result.then(
    async (r) => {
      try {
        await linkWorkflowSnapshotToWorkflow(runId, organizationId, workflowId);
      } catch (err) {
        logger.error(`workflow execute background update failed: runId=${runId}`, err);
      }
      if (r.spawnedEnvIds && r.spawnedEnvIds.length > 0) {
        try {
          await cleanupSpawnedEnvironments(new Set(r.spawnedEnvIds), organizationId);
        } catch (err) {
          logger.error(`workflow execute background cleanup failed: runId=${runId}`, err);
        }
      }
    },
    async (err) => {
      logger.error(`workflow execute background error: runId=${runId}`, err);
    },
  );

  if (body.mode === "async") {
    return { runId, version };
  }

  const timeoutMs = (body.timeout ?? 300) * 1000;

  try {
    const dagResult = await Promise.race([
      result,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs)),
    ]);

    const duration = (Date.now() - startTime) / 1000;

    if (dagResult.status === "SUCCESS") {
      // 优先使用本次调度结果携带的内存输出，避免刚完成后再查 storage 出现可见性/适配器实例差异。
      let output: Record<string, unknown> | undefined;
      if (endNode) {
        const nodeOutput = dagResult.outputs?.[endNode.id] ?? (await engine.getOutput(runId, endNode.id));
        if (nodeOutput?.json && typeof nodeOutput.json === "object" && !Array.isArray(nodeOutput.json)) {
          output = nodeOutput.json as Record<string, unknown>;
        }
        if (!output) {
          logger.warn(`End node output is empty: runId=${runId} nodeId=${endNode.id}`);
        }
      }
      return { runId, status: "SUCCESS" as const, version, output, duration };
    }

    return {
      runId,
      status: "FAILED" as const,
      version,
      error: { message: `DAG execution failed with status: ${dagResult.status}` },
      duration,
    };
  } catch (err) {
    if ((err as Error).message === "TIMEOUT") {
      return { runId, status: "TIMEOUT" as const, version, duration: (Date.now() - startTime) / 1000 };
    }
    throw err;
  }
}
