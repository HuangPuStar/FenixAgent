/** Workflow v2 手工测试：bun scripts/test-workflow-v2-api-v1.ts；--list 仅列接口。 */
import { runManualScenario } from "./lib/external-api-v1/manual-cli";
import {
  runWorkflowV2Scenario,
  validateWorkflowV2Config,
  WORKFLOW_V2_OPERATIONS,
} from "./lib/external-api-v1/workflows";

if (import.meta.main)
  await runManualScenario({
    configName: "WORKFLOW_V2_CONFIG",
    description: "Workflow v2 同步执行（会保留运行记录）",
    operations: WORKFLOW_V2_OPERATIONS,
    validate: validateWorkflowV2Config,
    run: runWorkflowV2Scenario,
  });
