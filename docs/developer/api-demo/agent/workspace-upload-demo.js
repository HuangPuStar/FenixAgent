import { createApiClient, getDemoConfig, loadUploadFile, logSection, requireValue } from "./common.js";

const config = getDemoConfig();
const api = createApiClient(config);
const action = process.argv[2] ?? "upload";

/**
 * 输出 workspace demo 的使用说明。
 */
function printUsage() {
  console.log(`Usage:
  bun workspace-upload-demo.js
    上传一个本地文件到 Agent 对应 environment 的 workspace

Required env:
  API_KEY
    Fenix 控制台生成的 External API Key

Optional env:
  BASE_URL
    Fenix 服务地址，默认是 http://localhost:3000
  AGENT_CONFIG_ID
    要连接的 AgentConfig ID；未传 ENVIRONMENT_ID 时会先通过它做 connect
  ENVIRONMENT_ID
    已有 environment ID；传入后可跳过自动 connect
  UPLOAD_PATH
    上传目标子目录，最终会写到 user/<UPLOAD_PATH>/
  UPLOAD_FILE
    要上传的本地文件路径
`);
}

/**
 * 通过 connect 自动准备 environment，避免调用方先手工查环境。
 * 如果外部系统已经缓存了 environmentId，也可以直接通过环境变量传入复用。
 */
async function resolveEnvironmentId() {
  if (config.environmentId) return config.environmentId;
  const agentConfigId = requireValue("AGENT_CONFIG_ID", config.agentConfigId);
  const connected = await api.request(`/api/agents/${agentConfigId}/instances/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferNewInstance: false }),
  });
  return requireValue("environmentId", connected.environmentId);
}

if (action === "--help" || action === "-h") {
  printUsage();
  process.exit(0);
}

const environmentId = await resolveEnvironmentId();
const uploadFile = await loadUploadFile(config.uploadFile);
const formData = new FormData();

// workspace 上传接口按“目标目录 + 文件集合”组织。
// 这里固定演示单文件上传，但同一个表单里可以追加多个 files 字段。
formData.append("path", config.uploadPath);
formData.append("files", uploadFile);

logSection(`POST /api/environments/${environmentId}/workspace/files`);
console.log(`Uploading ${uploadFile.name} -> user/${config.uploadPath}/`);

// 上传完成后原样打印返回值，方便调用方确认实际写入路径和服务端回包结构。
const result = await api.request(`/api/environments/${environmentId}/workspace/files`, {
  method: "POST",
  body: formData,
});

console.log(JSON.stringify(result, null, 2));
