---
name: agent-platform-api
description: RCS Platform API client. Use this skill to operate the RCS platform — manage environments, sessions, agents, tasks, knowledge bases, workflows, and more. Triggers include requests to "list environments", "create a session", "check agent config", "run a workflow", "manage tasks", "query knowledge base", and any RCS platform operation. Write a temporary .ts script, import from the bundle, then run with bun.
allowed-tools: Bash
---

# RCS Platform API

## Overview

This skill lets you operate the RCS platform by writing TypeScript scripts that call the RCS REST API. The SDK bundle is pre-installed at a known path. You write a `.ts` script, import the API classes you need, and run it with `bun`.

## Quick Start

1. Use the **Write** tool to create a temporary `.ts` file inside the user workspace's `user/` dir
2. Write a script using direct `fetch` with API key auth
3. Run with `bun`

```typescript
const BASE = "http://localhost:3000";

async function main() {
  const res = await fetch(`${BASE}/web/environments`, {
    headers: { Authorization: "Bearer rcs_xxx_..." },
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

await main();
```

## Authentication

RCS has **3 separate auth mechanisms**. Which one to use depends on the route and context:

| Auth mechanism | Routes | Method | Used when |
|---|---|---|---|
| **Session cookie** (`sessionAuth`) | `/web/*`, `/web/apiKeys` | Cookie `better-auth.session_token` | Web UI, browser-based usage |
| **Environment secret** (`apiKeyAuth`) | `/v1/*`, `/v2/*`, `/acp/*` | `Authorization: Bearer env_secret_xxx` | acp-link/worker processes (RCS auto-injects) |
| **better-auth API Key** (`apiKeyAuth`) | `/v1/*`, `/v2/*`, `/acp/*` | `Authorization: Bearer rcs_xxx` | Scripts, programmatic access |

⚠️ **Important**: `/web/*` routes only support session cookie auth. They do NOT accept API keys. To call web routes programmatically, you currently need a session cookie.

### For acp-link internal use (bundle works here)

The SDK bundle (`agent-platform-api.js`) is designed to run inside **RCS-spawned acp-link processes**. RCS automatically sets `USER_META_BASE_URL` and `USER_META_API_KEY` (= environment secret `env_secret_xxx`). The bundle intercepts `globalThis.fetch` to add the Bearer token. This works on routes with `apiKeyAuth` (`/v1/*`, `/v2/*`).

### For external scripts — two options

#### Option A: Create a better-auth API key (recommended for v1/v2 routes)

Sign in once with the test account to create an API key, then use it:

```typescript
const BASE = "http://localhost:3000";

async function createApiKey(): Promise<string> {
  const login = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "admin123456" }),
  });
  const cookie = login.headers.get("set-cookie")!;

  // Create API key with org metadata
  const res = await fetch(`${BASE}/web/apiKeys`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ action: "create", name: "script-key" }),
  });
  const data = await res.json();
  return data.data.key; // "rcs_..."
}

const API_KEY = await createApiKey();
// Now use API_KEY on routes with apiKeyAuth: /v1/*, /v2/*
const res = await fetch(`${BASE}/v1/environments/bridge`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
  body: JSON.stringify({ machine_name: "test" }),
});
```

#### Option B: Use session cookie (for `/web/*` routes)

Since `/web/*` routes only support `sessionAuth`, you must use the session cookie:

```typescript
const BASE = "http://localhost:3000";

async function api(path: string) {
  const login = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@test.com", password: "admin123456" }),
  });
  const res = await fetch(`${BASE}${path}`, {
    headers: { Cookie: login.headers.get("set-cookie")! },
  });
  return res.json();
}

const envs = await api("/web/environments");
```

### Auth notes

- Test account: `admin@test.com` / `admin123456`
- `RCS_API_KEYS` env var is for JWT signing only, NOT for Bearer auth
- Environment secrets (`env_secret_xxx`) are auto-generated per environment, stored in `environment.secret` column
- better-auth API keys (`rcs_xxx`) are created via `POST /web/apiKeys`

## Result Handling

All API methods return `{ ok: true, data: T }` or `{ ok: false, error: { code, message, status? } }`.

**Always check `result.ok` before using `result.data`:**

```typescript
const result = await api.list();
if (!result.ok) {
    console.error(JSON.stringify(result.error));
    process.exit(1);
}
console.log(JSON.stringify(result.data));
```

## API Reference

### EnvironmentApi — `/web/environments`

| Method                  | Params                               | Returns                     |
| ----------------------- | ------------------------------------ | --------------------------- |
| `list()`                | —                                    | `EnvironmentListResponse[]` |
| `create(body)`          | `CreateEnvironmentRequest`           | `EnvironmentDetailResponse` |
| `get({ id })`           | `{ id: string }`                     | `EnvironmentDetailResponse` |
| `update({ id }, body)`  | `{ id }`, `UpdateEnvironmentRequest` | `UpdateEnvironmentResponse` |
| `delete({ id })`        | `{ id: string }`                     | `DeleteEnvironmentResponse` |
| `enter({ id }, body?)`  | `{ id }`, `{ instance_number? }`     | `EnterEnvironmentResponse`  |
| `listInstances({ id })` | `{ id: string }`                     | `ListInstancesResponse`     |

### SessionApi — `/web/sessions`

| Method            | Params                    | Returns               |
| ----------------- | ------------------------- | --------------------- |
| `list()`          | —                         | `SessionListResponse` |
| `create(body)`    | `Record<string, unknown>` | `SessionResponse`     |
| `get({ id })`     | `{ id: string }`          | `SessionResponse`     |
| `history({ id })` | `{ id: string }`          | `SessionHistory`      |

### ControlApi — `/web/sessions/:id/events`

| Method                       | Params                              | Returns             |
| ---------------------------- | ----------------------------------- | ------------------- |
| `sendEvent({ id }, payload)` | `{ id }`, `Record<string, unknown>` | `SendEventResponse` |
| `control({ id }, payload)`   | `{ id }`, `Record<string, unknown>` | `SendEventResponse` |
| `interrupt({ id })`          | `{ id: string }`                    | `InterruptResponse` |

### InstanceApi — `/web/instances`

| Method           | Params                                | Returns                  |
| ---------------- | ------------------------------------- | ------------------------ |
| `create(body)`   | `Record<string, unknown>`             | `InstanceInfo`           |
| `spawn(body)`    | `SpawnInstanceFromEnvironmentRequest` | `InstanceInfo`           |
| `list()`         | —                                     | `InstanceListResponse`   |
| `delete({ id })` | `{ id: string }`                      | `DeleteInstanceResponse` |

### ProviderApi — `/web/config/providers`

| Method                       | Params                              | Returns               |
| ---------------------------- | ----------------------------------- | --------------------- |
| `list()`                     | —                                   | `ProviderInfo[]`      |
| `get(name)`                  | `string`                            | `ProviderDetail`      |
| `set(name, data)`            | `string`, `Record<string, unknown>` | `ProviderInfo`        |
| `test(name)`                 | `string`                            | `{ success, error? }` |
| `delete(name)`               | `string`                            | `boolean`             |
| `addModel(name, data)`       | `string`, `Record<string, unknown>` | `ModelEntry`          |
| `updateModel(name, data)`    | `string`, `Record<string, unknown>` | `ModelEntry`          |
| `removeModel(name, modelId)` | `string`, `string`                  | `boolean`             |

### ModelApi — `/web/config/models`

| Method      | Params                    | Returns        |
| ----------- | ------------------------- | -------------- |
| `get()`     | —                         | `ModelConfig`  |
| `set(data)` | `Record<string, unknown>` | `ModelConfig`  |
| `refresh()` | —                         | `ModelEntry[]` |

### AgentApi — `/web/config/agents`

| Method               | Params                              | Returns       |
| -------------------- | ----------------------------------- | ------------- |
| `list()`             | —                                   | `AgentInfo[]` |
| `get(name)`          | `string`                            | `AgentDetail` |
| `set(name, data)`    | `string`, `Record<string, unknown>` | `AgentDetail` |
| `create(name, data)` | `string`, `Record<string, unknown>` | `AgentDetail` |
| `delete(name)`       | `string`                            | `boolean`     |
| `setDefault(name)`   | `string`                            | `boolean`     |

### SkillConfigApi — `/web/config/skills`

| Method             | Params                              | Returns       |
| ------------------ | ----------------------------------- | ------------- |
| `list()`           | —                                   | `SkillInfo[]` |
| `get(name)`        | `string`                            | `SkillInfo`   |
| `set(name, data)`  | `string`, `Record<string, unknown>` | `SkillInfo`   |
| `delete(name)`     | `string`                            | `boolean`     |
| `upload(formData)` | `FormData`                          | `SkillInfo`   |

### McpApi — `/web/config/mcp`

| Method               | Params                              | Returns               |
| -------------------- | ----------------------------------- | --------------------- |
| `list()`             | —                                   | `McpServerInfo[]`     |
| `get(name)`          | `string`                            | `McpServerDetail`     |
| `create(name, data)` | `string`, `Record<string, unknown>` | `McpServerInfo`       |
| `set(name, data)`    | `string`, `Record<string, unknown>` | `McpServerInfo`       |
| `delete(name)`       | `string`                            | `boolean`             |
| `enable(name)`       | `string`                            | `McpServerInfo`       |
| `disable(name)`      | `string`                            | `McpServerInfo`       |
| `test(name)`         | `string`                            | `{ success, error? }` |
| `testUrl(url)`       | `string`                            | `{ success, error? }` |
| `inspect(name)`      | `string`                            | `McpInspectResult`    |
| `listTools(name)`    | `string`                            | `McpToolInfo[]`       |

### KnowledgeBaseApi — `/web/knowledgeBases`

| Method                               | Params                                 | Returns                            |
| ------------------------------------ | -------------------------------------- | ---------------------------------- |
| `list()`                             | —                                      | `KnowledgeBaseListResponse`        |
| `create(body)`                       | `CreateKnowledgeBaseRequest`           | `KnowledgeBaseInfo`                |
| `get({ id })`                        | `{ id: string }`                       | `KnowledgeBaseInfo`                |
| `update({ id }, body)`               | `{ id }`, `UpdateKnowledgeBaseRequest` | `KnowledgeBaseInfo`                |
| `delete({ id })`                     | `{ id: string }`                       | `DeleteKnowledgeBaseResponse`      |
| `uploadResources({ id }, formData)`  | `{ id }`, `FormData`                   | `UploadKnowledgeResourcesResponse` |
| `importUrl({ id }, body)`            | `{ id }`, `{ url, sourceName? }`       | `ImportKnowledgeUrlResponse`       |
| `listResources({ id })`              | `{ id: string }`                       | `KnowledgeResourceItem[]`          |
| `deleteResource({ id, resourceId })` | `{ id, resourceId }`                   | `DeleteKnowledgeResourceResponse`  |

### TaskApi — `/web/tasks`

| Method                 | Params                           | Returns                 |
| ---------------------- | -------------------------------- | ----------------------- |
| `list()`               | —                                | `TaskInfo[]`            |
| `create(body)`         | `CreateTaskRequest`              | `TaskInfo`              |
| `get({ id })`          | `{ id: string }`                 | `TaskInfo`              |
| `update({ id }, body)` | `{ id }`, `UpdateTaskRequest`    | `TaskInfo`              |
| `delete({ id })`       | `{ id: string }`                 | `DeleteTaskResponse`    |
| `toggle({ id })`       | `{ id: string }`                 | `ToggleTaskResponse`    |
| `trigger({ id })`      | `{ id: string }`                 | `TriggerTaskResponse`   |
| `logs({ id }, query?)` | `{ id }`, `{ page?, pageSize? }` | `PaginatedLogs`         |
| `clearLogs({ id })`    | `{ id: string }`                 | `ClearTaskLogsResponse` |

### OrganizationApi — `/web/organizations`

| Method                                       | Params                       | Returns       |
| -------------------------------------------- | ---------------------------- | ------------- |
| `list()`                                     | —                            | `OrgInfo[]`   |
| `get(organizationId)`                        | `string`                     | `OrgDetail`   |
| `getFull(organizationId)`                    | `string`                     | `OrgDetail`   |
| `create(body)`                               | `{ name, slug? }`            | `OrgInfo`     |
| `update(organizationId, body)`               | `string`, `{ name?, slug? }` | `OrgInfo`     |
| `delete(organizationId)`                     | `string`                     | `{ success }` |
| `setActive(organizationId)`                  | `string`                     | `{ success }` |
| `listMembers(organizationId)`                | `string`                     | `OrgMember[]` |
| `addMember(organizationId, body)`            | `string`, `{ email, role }`  | `OrgMember`   |
| `removeMember(organizationId, memberId)`     | `string`, `string`           | `{ success }` |
| `updateRole(organizationId, memberId, role)` | `string`, `string`, `string` | `{ success }` |

### ApiKeyApi — `/web/apiKeys`

| Method             | Params                              | Returns        |
| ------------------ | ----------------------------------- | -------------- |
| `list()`           | —                                   | `ApiKeyInfo[]` |
| `create(body)`     | `{ name, expiresIn? }`              | `{ key }`      |
| `delete(id)`       | `string`                            | `{ success }`  |
| `update(id, data)` | `string`, `Record<string, unknown>` | `ApiKeyInfo`   |

### FileApi — `/web/environments/:id/user`

| Method                            | Params                         | Returns              |
| --------------------------------- | ------------------------------ | -------------------- |
| `listDir({ id }, query?)`         | `{ id }`, `{ path? }`          | `FileListResponse`   |
| `readFile({ id, path }, query?)`  | `{ id, path }`, `{ preview? }` | `FileContent`        |
| `upload({ id, path? }, formData)` | `{ id, path? }`, `FormData`    | `FileUploadResponse` |
| `writeFile({ id, path }, body)`   | `{ id, path }`, `{ content }`  | `FileWriteResult`    |
| `deleteFile({ id, path })`        | `{ id, path }`                 | `OkResponse`         |

### UserFileApi — `/web/environments/:id/user-file`

| Method                      | Params                           | Returns               |
| --------------------------- | -------------------------------- | --------------------- |
| `tree({ id })`              | `{ id: string }`                 | `TreeResponse`        |
| `rename({ id }, body)`      | `{ id }`, `{ oldPath, newPath }` | `RenameResponse`      |
| `mkdir({ id }, body)`       | `{ id }`, `{ path }`             | `MkdirResponse`       |
| `batchDelete({ id }, body)` | `{ id }`, `{ paths }`            | `BatchDeleteResponse` |

### S3FileApi — `/web/s3/files`

| Method                    | Params                            | Returns                |
| ------------------------- | --------------------------------- | ---------------------- |
| `list(query)`             | `{ sessionId, prefix? }`          | `S3FileListResponse`   |
| `presignGet(query)`       | `{ sessionId, key }`              | `S3PresignGetResponse` |
| `presignPut(body)`        | `{ sessionId, key, contentType }` | `S3PresignPutResponse` |
| `upload(query, formData)` | `{ sessionId }`, `FormData`       | `S3UploadResponse`     |
| `deleteFile(body)`        | `{ sessionId, key }`              | `OkResponse`           |

### ChannelApi — `/web/channels`

| Method                        | Params                        | Returns                        |
| ----------------------------- | ----------------------------- | ------------------------------ |
| `listProviders()`             | —                             | `ChannelProviderListResponse`  |
| `hermesStatus()`              | —                             | `HermesStatus`                 |
| `listBindings()`              | —                             | `ChannelBindingListResponse`   |
| `createBinding(body)`         | `CreateChannelBindingRequest` | `CreateChannelBindingResponse` |
| `deleteBinding({ id })`       | `{ id: string }`              | `DeleteChannelBindingResponse` |
| `updateBinding({ id }, body)` | `{ id }`, `Partial<...>`      | `UpdateChannelBindingResponse` |

### WorkflowDefApi — `/web/workflow-defs`

| Method                                | Params                              | Returns     |
| ------------------------------------- | ----------------------------------- | ----------- |
| `create(body)`                        | `Record<string, unknown>`           | `unknown`   |
| `save(workflowId, yaml)`              | `string`, `string`                  | `unknown`   |
| `publish(workflowId)`                 | `string`                            | `unknown`   |
| `list()`                              | —                                   | `unknown`   |
| `get(workflowId)`                     | `string`                            | `unknown`   |
| `getVersions(workflowId)`             | `string`                            | `unknown`   |
| `getVersion(workflowId, version)`     | `string`, `number`                  | `unknown`   |
| `setLatest(workflowId, version)`      | `string`, `number`                  | `unknown`   |
| `delete(workflowId)`                  | `string`                            | `unknown`   |
| `updateMeta(workflowId, data)`        | `string`, `Record<string, unknown>` | `unknown`   |
| `restoreToDraft(workflowId, version)` | `string`, `number`                  | `unknown`   |
| `recover()`                           | —                                   | `string[]`  |
| `recoverApply(workflowIds)`           | `string[]`                          | `unknown[]` |

### WorkflowEngineApi — `/web/workflow-engine`

| Method                                 | Params                                  | Returns       |
| -------------------------------------- | --------------------------------------- | ------------- |
| `run(workflowId, body?)`               | `string`, `Record<string, unknown>?`    | `{ runId }`   |
| `dryRun(workflowId, body?)`            | `string`, `Record<string, unknown>?`    | `unknown`     |
| `cancel(runId)`                        | `string`                                | `{ success }` |
| `approve(runId, nodeId, token, data?)` | `string`, `string`, `string`, `Record?` | `{ success }` |
| `getRunStatus(runId)`                  | `string`                                | `unknown`     |
| `getEvents(runId)`                     | `string`                                | `unknown`     |
| `getOutput(runId, nodeId)`             | `string`, `string`                      | `unknown`     |
| `getPendingApprovals(runId)`           | `string`                                | `unknown`     |
| `listRuns(workflowId?)`                | `string?`                               | `unknown`     |
| `recover(runId)`                       | `string`                                | `unknown`     |
| `rerunFrom(runId, nodeId)`             | `string`, `string`                      | `unknown`     |

### MetaAgentApi — `/web/meta-agent`

| Method     | Params | Returns        |
| ---------- | ------ | -------------- |
| `ensure()` | —      | `{ id, name }` |

### AuthApi — `/web/bind`

| Method        | Params                  | Returns             |
| ------------- | ----------------------- | ------------------- |
| `bind(body?)` | `{ sessionId?, uuid? }` | `{ ok, sessionId }` |

### V1EnvironmentApi — `/v1/environments`

| Method                      | Params                      | Returns                      |
| --------------------------- | --------------------------- | ---------------------------- |
| `registerBridge(body)`      | `BridgeRegistrationRequest` | `BridgeRegistrationResponse` |
| `deregisterBridge({ id })`  | `{ id: string }`            | `StatusOkResponse`           |
| `reconnectBridge({ id })`   | `{ id: string }`            | `StatusOkResponse`           |
| `pollWork({ id })`          | `{ id: string }`            | `unknown`                    |
| `ackWork({ id, workId })`   | `{ id, workId }`            | `StatusOkResponse`           |
| `stopWork({ id, workId })`  | `{ id, workId }`            | `StatusOkResponse`           |
| `heartbeat({ id, workId })` | `{ id, workId }`            | `StatusOkResponse`           |

### V1SessionApi — `/v1/sessions`

| Method                     | Params                           | Returns                   |
| -------------------------- | -------------------------------- | ------------------------- |
| `create(body)`             | `CreateSessionRequest`           | `V1CreateSessionResponse` |
| `get({ id })`              | `{ id: string }`                 | `V1GetSessionResponse`    |
| `update({ id }, body)`     | `{ id }`, `UpdateSessionRequest` | `V1GetSessionResponse`    |
| `archive({ id })`          | `{ id: string }`                 | `StatusOkResponse`        |
| `sendEvents({ id }, body)` | `{ id }`, `{ events }`           | `V1SendEventsResponse`    |

### V2CodeSessionApi — `/v1/code/sessions`

| Method           | Params                     | Returns                     |
| ---------------- | -------------------------- | --------------------------- |
| `create(body)`   | `CreateCodeSessionRequest` | `CreateCodeSessionResponse` |
| `bridge({ id })` | `{ id: string }`           | `CodeSessionBridgeResponse` |

### V2WorkerApi — `/v1/code/sessions/:id/worker`

| Method                           | Params                          | Returns                   |
| -------------------------------- | ------------------------------- | ------------------------- |
| `get({ id })`                    | `{ id: string }`                | `GetWorkerResponse`       |
| `update({ id }, body)`           | `{ id }`, `UpdateWorkerRequest` | `UpdateWorkerResponse`    |
| `heartbeat({ id })`              | `{ id: string }`                | `WorkerHeartbeatResponse` |
| `register({ id })`               | `{ id: string }`                | `StatusOkResponse`        |
| `sendEvents({ id }, body)`       | `{ id }`, `WorkerEventsRequest` | `WorkerEventsResponse`    |
| `updateState({ id }, body)`      | `{ id }`, `WorkerStateRequest`  | `StatusOkResponse`        |
| `updateMetadata({ id })`         | `{ id: string }`                | `StatusOkResponse`        |
| `deliveryBatch({ id })`          | `{ id: string }`                | `StatusOkResponse`        |
| `deliveryEvent({ id, eventId })` | `{ id, eventId }`               | `StatusOkResponse`        |
