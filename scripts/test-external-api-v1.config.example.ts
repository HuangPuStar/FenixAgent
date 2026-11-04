import type { AgentTestConfig, WorkflowTestConfig, WorkflowV2TestConfig } from "./lib/external-api-v1/config";

// 复制为同目录 test-external-api-v1.config.local.ts 后填写；本地文件已被 Git 忽略。
export const AGENT_CONFIG: AgentTestConfig = {
  baseUrl: "http://localhost:3301",
  apiKey: "EDIT_PLATFORM_API_KEY",
  timeoutMs: 360_000,
  provider: {
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "EDIT_UPSTREAM_API_KEY", // 无认证的本地模型可填 ""。
  },
  upstreamModel: "EDIT_UPSTREAM_MODEL_NAME", // 上游模型名称，例如 gpt-4.1-mini。
  runtimeModelId: "", // 留空使用本轮新建模型；也可填写已有模型的数据库 ID（包含模型网关）。
  knowledgeBaseId: "EDIT_EXISTING_KNOWLEDGE_BASE_ID", // 只查询、绑定，不修改现有知识库。
  mcpConfig: {
    type: "streamable-http",
    url: "EDIT_REACHABLE_MCP_URL", // 应能从 Agent 所在的 machine / sandbox 访问。
    headers: {}, // 需要的 MCP 凭据也填在这里；日志会遮盖。
    enabled: true,
  },
  agentNode: {}, // 默认节点；或 { kind: "machine", machineId: "..." } / { kind: "sandbox", sandboxPoolId: "..." }。
  acpPermission: "deny", // 三轮纯文本聊天不需要工具授权；需观察工具行为可改为 allow_once。
};

// 三个入口分别读取自己的配置；工作流 ID 留空或保留 EDIT_ 时会红字提示并跳过。
export const WORKFLOW_CONFIG: WorkflowTestConfig = {
  baseUrl: "http://localhost:3301",
  apiKey: "EDIT_PLATFORM_API_KEY",
  timeoutMs: 360_000,
  workflowId: "EDIT_PUBLISHED_WORKFLOW_ID",
  inputs: {},
};

export const WORKFLOW_V2_CONFIG: WorkflowV2TestConfig = {
  baseUrl: "http://localhost:3301",
  apiKey: "EDIT_PLATFORM_API_KEY",
  timeoutMs: 360_000,
  workflowId: "EDIT_PUBLISHED_WORKFLOW_V2_UUID", // 平台 UUID，不是上游 workflow ID。
  parameters: {},
};
