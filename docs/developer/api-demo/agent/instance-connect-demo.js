import { createApiClient, getDemoConfig, logSection, requireValue, toAbsoluteUrl } from "./common.js";

const config = getDemoConfig();
const api = createApiClient(config);
const action = process.argv[2] ?? "connect";

/**
 * 输出 instance demo 的使用说明。
 */
function printUsage() {
  console.log(`Usage:
  bun instance-connect-demo.js
    为指定 Agent 准备可连接的 instance，并返回 relay.wsUrl

Required env:
  API_KEY
    Fenix 控制台生成的 External API Key

Optional env:
  BASE_URL
    Fenix 服务地址，默认是 http://localhost:3000
  AGENT_CONFIG_ID
    要连接的 AgentConfig ID；不传时会自动取第一个 Agent
`);
}

/**
 * 在未显式提供 Agent ID 时，自动拿第一个 Agent 当作 demo 对象。
 * 这样第一次跑 demo 时，不必先手工抄一个 AgentConfig ID。
 */
async function resolveAgentId() {
  if (config.agentConfigId) return config.agentConfigId;

  const result = await api.request("/api/agents?page=1&pageSize=1");
  const first = Array.isArray(result.items) ? result.items[0] : null;
  if (!first?.id) {
    throw new Error("No agent available. Please create one first or set AGENT_CONFIG_ID.");
  }
  return first.id;
}

if (action === "--help" || action === "-h") {
  printUsage();
  process.exit(0);
}

const agentConfigId = await resolveAgentId();

// connect 是外部调用进入 Agent 运行链路的主入口。
// 它会由后端负责准备 environment、复用或拉起 instance，并返回可继续连接的 relay 信息。
logSection(`POST /api/agents/${agentConfigId}/instances/connect`);
const result = await api.request(`/api/agents/${agentConfigId}/instances/connect`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ preferNewInstance: false }),
});

// 原样输出响应，便于调用方观察 environmentId、instanceId、relay.wsUrl 的具体结构。
console.log(JSON.stringify(result, null, 2));
console.log("\nResolved relay URL:");
console.log(toAbsoluteUrl(config.baseUrl, requireValue("relay.wsUrl", result.relay?.wsUrl ?? "")));
