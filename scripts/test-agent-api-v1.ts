/** Agent 全流程测试：bun scripts/test-agent-api-v1.ts；-t 逐步交互，--list 仅列接口。 */
import { runManualScenario } from "./lib/external-api-v1/manual-cli";
import { AGENT_OPERATIONS, runAgentScenario, validateAgentConfig } from "./lib/external-api-v1/scenario";

if (import.meta.main)
  await runManualScenario({
    configName: "AGENT_CONFIG",
    description: "Agent 配置、实例、上传和多轮对话（会创建资源并真实调用模型）",
    operations: AGENT_OPERATIONS,
    extraCoverage: "，另含 ACP WebSocket 三轮对话",
    validate: validateAgentConfig,
    run: runAgentScenario,
    secrets: (config) => [
      config.provider.apiKey,
      ...Object.values((config.mcpConfig.headers ?? {}) as Record<string, string>),
    ],
  });
