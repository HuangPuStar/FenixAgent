/** Published external v1 operations, including both workflow execution adapters. */
export const EXTERNAL_V1_OPERATIONS = [
  ...["agents", "providers", "skills", "mcp-servers"].flatMap((resource) => [
    `GET /api/v1/${resource}`,
    `POST /api/v1/${resource}`,
    ...["GET", "PATCH", "DELETE"].map(
      (method) => `${method} /api/v1/${resource}/{${resource === "providers" ? "providerId" : "id"}}`,
    ),
  ]),
  "GET /api/v1/providers/{providerId}/models",
  "POST /api/v1/providers/{providerId}/models",
  ...["GET", "PATCH", "DELETE"].map((method) => `${method} /api/v1/providers/{providerId}/models/{id}`),
  "GET /api/v1/knowledge-bases",
  "GET /api/v1/agents/{id}/instances",
  "POST /api/v1/agents/{id}/instances/connect",
  "GET /api/v1/instances/{id}",
  "POST /api/v1/instances/{id}/stop",
  "POST /api/v1/instances/{id}/restart",
  "POST /api/v1/environments/{environmentId}/workspace/files",
  "GET /api/v1/environments/{environmentId}/workspace/files",
  "GET /api/v1/environments/{environmentId}/workspace/files/download",
  "POST /api/v1/chat/completions",
  "POST /api/v1/workflows/{workflowId}/execute",
  "POST /api/v1/workflow-v2/workflows/{id}/run",
].sort();
