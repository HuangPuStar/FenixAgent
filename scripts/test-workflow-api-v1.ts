/** 旧版工作流测试：bun scripts/test-workflow-api-v1.ts；-t 逐步交互，--list 仅列接口。 */
import { runManualScenario } from "./lib/external-api-v1/manual-cli";
import { runWorkflowScenario, validateWorkflowConfig, WORKFLOW_OPERATIONS } from "./lib/external-api-v1/workflows";

if (import.meta.main)
  await runManualScenario({
    configName: "WORKFLOW_CONFIG",
    description: "旧版工作流同步执行（会保留运行记录）",
    operations: WORKFLOW_OPERATIONS,
    validate: validateWorkflowConfig,
    run: runWorkflowScenario,
  });
