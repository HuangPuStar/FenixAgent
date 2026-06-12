import { createApiClient, getDemoConfig, logSection, requireValue } from "./common.js";

const config = getDemoConfig();
const api = createApiClient(config);
const action = process.argv[2] ?? "crud";
const targetId = process.argv[3] ?? "";

/**
 * 打印脚本使用方式，便于对方快速照抄。
 */
function printUsage() {
  console.log(`Usage:
  bun agent-config-demo.js list
    查询 AgentConfig 列表
  bun agent-config-demo.js get <agentConfigId>
    查询单个 AgentConfig
  bun agent-config-demo.js create
    创建一个新的 AgentConfig
  bun agent-config-demo.js update <agentConfigId>
    更新指定 AgentConfig
  bun agent-config-demo.js delete <agentConfigId>
    删除指定 AgentConfig
  bun agent-config-demo.js crud
    按顺序演示一遍完整的 CRUD 流程

Required env:
  API_KEY
    Fenix 控制台生成的 External API Key

Required env for create/update/crud:
  MODEL_ID
    创建或更新 AgentConfig 时使用的模型 ID

Optional env:
  BASE_URL
    Fenix 服务地址，默认是 http://localhost:3000
`);
}

/**
 * 构造统一的 Agent 请求体，避免 demo 之间字段漂移。
 * 参考代码时，可以把这里当作“创建 AgentConfig 的最小可用字段集”。
 */
function buildAgentBody(name, description, prompt) {
  const modelId = requireValue("MODEL_ID", config.modelId);
  return {
    name,
    modelId,
    prompt,
    description,
    skillIds: [],
    mcpIds: [],
    publicReadable: false,
  };
}

/**
 * 读取 AgentConfig 列表。
 * 这里固定使用一页 20 条，重点是演示最小调用方式，而不是分页遍历策略。
 */
async function listAgents() {
  logSection("GET /api/agents");
  const result = await api.request("/api/agents?page=1&pageSize=20");
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 读取单个 AgentConfig。
 */
async function getAgent(agentConfigId) {
  logSection(`GET /api/agents/${agentConfigId}`);
  const result = await api.request(`/api/agents/${agentConfigId}`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 创建一个新的 AgentConfig。
 * 名称带时间戳，避免多次运行 demo 时与已有数据冲突。
 */
async function createAgent() {
  const suffix = Date.now();
  const body = buildAgentBody(
    `External Demo Agent ${suffix}`,
    "通过 external API demo 创建",
    "You are an external API demo agent.",
  );

  logSection("POST /api/agents");
  console.log(JSON.stringify(body, null, 2));
  const result = await api.request("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 只更新一小部分字段，演示 PUT 的典型用法。
 */
async function updateAgent(agentConfigId) {
  const body = {
    description: `通过 external API demo 更新于 ${new Date().toISOString()}`,
    prompt: "You are an updated external API demo agent.",
  };

  logSection(`PUT /api/agents/${agentConfigId}`);
  console.log(JSON.stringify(body, null, 2));
  const result = await api.request(`/api/agents/${agentConfigId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 删除一个 AgentConfig。
 */
async function deleteAgent(agentConfigId) {
  logSection(`DELETE /api/agents/${agentConfigId}`);
  const result = await api.request(`/api/agents/${agentConfigId}`, { method: "DELETE" });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * 串行跑完整 CRUD，便于第一次接触 External API 的人快速看到整条链路。
 */
async function runCrudFlow() {
  await listAgents();
  const created = await createAgent();
  const agentConfigId = created.id;

  await getAgent(agentConfigId);
  await updateAgent(agentConfigId);
  await getAgent(agentConfigId);
  await deleteAgent(agentConfigId);
}

if (action === "--help" || action === "-h") {
  printUsage();
  process.exit(0);
}

// CLI 入口分发：每个分支都只做一类动作，方便调用方按需复制其中一段逻辑。
switch (action) {
  case "list":
    await listAgents();
    break;
  case "get":
    await getAgent(requireValue("agentConfigId", targetId));
    break;
  case "create":
    await createAgent();
    break;
  case "update":
    await updateAgent(requireValue("agentConfigId", targetId));
    break;
  case "delete":
    await deleteAgent(requireValue("agentConfigId", targetId));
    break;
  case "crud":
    await runCrudFlow();
    break;
  default:
    printUsage();
    process.exitCode = 1;
}
