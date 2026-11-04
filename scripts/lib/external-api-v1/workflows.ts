import assert from "node:assert/strict";
import { validateConnectionConfig, type WorkflowTestConfig, type WorkflowV2TestConfig } from "./config";
import { field, type ManualRunner, object } from "./runner";

/** 旧版工作流外部执行接口。 */
export const WORKFLOW_OPERATIONS = ["POST /api/v1/workflows/{workflowId}/execute"];

/** Workflow v2 外部执行接口。 */
export const WORKFLOW_V2_OPERATIONS = ["POST /api/v1/workflow-v2/workflows/{id}/run"];

/** 保留工作流 ID 未填写时提示并跳过的手工联调行为。 */
function configuredId(id: string, name: string, runner: ManualRunner): string | undefined {
  const value = id?.trim();
  if (value && !value.includes("EDIT_")) return encodeURIComponent(value);
  runner.print("\u001b[31m跳过", `未配置 ${name}.workflowId，请填写同一个本地配置文件后再测试。\u001b[0m`);
}

/** 只验证旧版工作流测试所需的连接配置。 */
export function validateWorkflowConfig(config: WorkflowTestConfig): void {
  validateConnectionConfig(config, "WORKFLOW_CONFIG");
}

/** 只验证 Workflow v2 测试所需的连接配置。 */
export function validateWorkflowV2Config(config: WorkflowV2TestConfig): void {
  validateConnectionConfig(config, "WORKFLOW_V2_CONFIG");
}

/** 同步执行已有旧版工作流，保留执行记录和工作流定义。 */
export async function runWorkflowScenario(config: WorkflowTestConfig, runner: ManualRunner): Promise<void> {
  const id = configuredId(config.workflowId, "WORKFLOW_CONFIG", runner);
  if (!id) return;
  await runner.request("POST", `/api/v1/workflows/${id}/execute`, {
    body: { inputs: config.inputs, mode: "sync", timeout: 300 },
    check: (data) => {
      field(data, "runId");
      assert.equal(object(data).status, "SUCCESS", "工作流未成功完成");
    },
  });
  runner.print("测试完成", { covered: runner.operations.size, expected: WORKFLOW_OPERATIONS.length });
}

/** 同步执行已有 Workflow v2，保留执行记录和工作流定义。 */
export async function runWorkflowV2Scenario(config: WorkflowV2TestConfig, runner: ManualRunner): Promise<void> {
  const id = configuredId(config.workflowId, "WORKFLOW_V2_CONFIG", runner);
  if (!id) return;
  await runner.request("POST", `/api/v1/workflow-v2/workflows/${id}/run`, {
    body: { parameters: config.parameters, isAsync: false },
    check: (data) => {
      const result = object(data);
      for (const key of ["executeId", "data", "token", "cost", "debugUrl"])
        assert.ok(Object.hasOwn(result, key), `缺少 ${key}`);
      runner.print("验证范围", "workflow-v2 同步接口已返回；上游业务结果请结合 data 与 debugUrl 检查。");
    },
  });
  runner.print("测试完成", { covered: runner.operations.size, expected: WORKFLOW_V2_OPERATIONS.length });
}
