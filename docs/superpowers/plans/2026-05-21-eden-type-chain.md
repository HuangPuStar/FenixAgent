# Eden Treaty Type Chain Restoration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `client.web: any` workaround with a manually typed API bridge module that provides full type safety for all frontend-to-backend HTTP calls, eliminating 110+ `unwrapEden<T>`/`unwrapConfigData<T>` casts across 35 files.
**Architecture:** Eden Treaty cannot resolve the `web` route namespace when the root Elysia app combines 15+ plugins (it falls back to `"Please install Elysia before using Eden"`). Since the backend uses dynamic `action`-dispatch routes (switch on `body.action`), OpenAPI codegen produces empty schemas. The solution is a typed bridge module (`web/src/api/typed-client.ts`) that wraps raw `fetch` with explicit request/response types imported from backend Zod schemas. Each API function has a typed signature; callers never touch `any` or `unwrapEden`.
**Tech Stack:** TypeScript, Zod schemas (re-exported from `src/schemas/`), native `fetch`, Biome lint

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `web/src/api/typed-client.ts` | Typed fetch wrapper + per-domain API functions (config, sessions, environments, tasks, etc.) |
| `web/src/api/types.ts` | Re-exported types from backend Zod schemas (`@server/schemas/*`), response wrapper types |

### Modified files
| File | Responsibility |
|------|---------------|
| `web/src/api/client.ts` | Keep Eden Treaty for SSE/fallback only; remove `unwrapEden`, `orgAction`, `& { web: any }` |
| `web/src/api/config-response.ts` | Remove `unwrapConfigData` (replaced by typed bridge) |
| `web/src/api/workflow-defs.ts` | Replace all `client.web.workflowDefs.post` + `unwrapEden` with typed API calls |
| `web/src/api/workflow-engine.ts` | Replace all `client.web.workflowEngine.post` + `unwrapEden` with typed API calls |
| `web/src/api/meta-agent.ts` | Replace `client.web.metaAgent.ensure.post` + `unwrapEden` with typed API call |
| `web/src/contexts/OrgContext.tsx` | Replace `client.web.organizations.post` + `unwrapEden` with typed API calls |
| `web/src/pages/Dashboard.tsx` | Replace `client.web.*` calls with typed API imports |
| `web/src/pages/AgentsPage.tsx` | Replace `client.web.config.agents.post` + `unwrapConfigData` with typed API calls |
| `web/src/pages/ModelsPage.tsx` | Replace `client.web.config.models.post` + `unwrapConfigData` with typed API calls |
| `web/src/pages/SkillsPage.tsx` | Replace `client.web.config.skills.post` + `unwrapConfigData` with typed API calls |
| `web/src/pages/McpPage.tsx` | Replace `client.web.config.mcp.post` + `unwrapConfigData` with typed API calls |
| `web/src/pages/EnvironmentsPage.tsx` | Replace `client.web.environments.*` with typed API calls |
| `web/src/pages/SessionDetail.tsx` | Replace `client.web.sessions.*` with typed API calls |
| `web/src/pages/TasksPage.tsx` | Replace `client.web.tasks.*` with typed API calls |
| `web/src/pages/KnowledgeBasesPage.tsx` | Replace `client.web.knowledgeBases.*` with typed API calls |
| `web/src/pages/ChannelsPage.tsx` | Replace `client.web.channels.*` with typed API calls |
| `web/src/pages/ApiKeyManager.tsx` | Replace `client.web.apiKeys.*` with typed API calls |
| `web/src/pages/OrgsPage.tsx` | Replace `client.web.organizations.post` + `unwrapEden` with typed API calls |
| `web/src/pages/agent-panel/AgentCreateDialog.tsx` | Replace `client.web.config.agents.post` + `unwrapConfigData` with typed API calls |
| `web/src/pages/agent-panel/AgentSidebarTree.tsx` | Replace `client.web.environments.*` with typed API calls |
| `web/src/pages/agent-panel/pages/AgentApiKeysPage.tsx` | Replace `client.web.apiKeys.*` + `unwrapEden` with typed API calls |
| `web/src/pages/agent-panel/pages/AgentChannelsPage.tsx` | Replace `client.web.channels.*` with typed API calls |
| `web/src/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx` | Replace `client.web.knowledgeBases.*` with typed API calls |
| `web/src/pages/agent-panel/pages/AgentMcpPage.tsx` | Replace `client.web.config.mcp.post` + `unwrapConfigData` with typed API calls |
| `web/src/pages/agent-panel/pages/AgentModelsPage.tsx` | Replace `client.web.config.models.post` + `unwrapConfigData` with typed API calls |
| `web/src/pages/agent-panel/pages/AgentSessionsPage.tsx` | Replace `client.web.sessions.*` with typed API calls |
| `web/src/pages/agent-panel/pages/AgentSkillsPage.tsx` | Replace `client.web.config.skills.post` + `unwrapConfigData` with typed API calls |
| `web/src/pages/agent-panel/pages/AgentTasksPage.tsx` | Replace `client.web.tasks.*` with typed API calls |
| `web/src/pages/workflow/WorkflowEditor.tsx` | Replace `client.web.workflowDefs.*` + `unwrapEden` with typed API calls |
| `web/src/components/FilePickerDialog.tsx` | Replace `client.web.environments.*` with typed API calls |
| `web/src/components/NewSessionDialog.tsx` | Replace `client.web.sessions.*` with typed API calls |
| `web/src/components/PermissionTab.tsx` | Replace `client.web.config.skills.*` with typed API calls |
| `web/src/components/ACPMain.tsx` | Replace `client.web.sessions.*` with typed API calls |
| `web/src/components/agent-panel/FileTreeTab.tsx` | Replace `client.web.environments.*` + `unwrapEden` with typed API calls |
| `web/src/components/agent-panel/PreviewTab.tsx` | Replace `client.web.environments.*` + `unwrapEden` with typed API calls |
| `web/src/components/config/ModelConfigDialog.tsx` | Replace `client.web.config.models.post` with typed API call |
| `web/src/lib/rcs-chat-adapter.ts` | Replace `client.web.sessions.*` with typed API calls |

---

## Tasks

### Task 1: Create type definitions module

**Files:**
- Create: `web/src/api/types.ts`

This module re-exports all backend Zod schema types via the `@server` path alias and defines the response wrapper types used by the typed client. No runtime code — pure type imports.

- [ ] **Step 1: Create `web/src/api/types.ts` with re-exported backend types and response wrappers**

```typescript
// web/src/api/types.ts
//
// Central type bridge: re-exports backend Zod schema types for frontend use.
// All types are import-only — no runtime code.

// ── Config types (from src/schemas/config.schema.ts) ──
export type {
  ConfigAction,
  ConfigBody,
  ProviderInfo,
  ProviderDetail,
  ModelEntry,
  ModelConfig,
  AgentInfo,
  AgentDetail,
  SkillInfo,
  SkillSourceInfo,
  McpServerInfo,
  McpServerDetail,
  McpToolInfo,
  McpInspectResult,
} from "@server/schemas/config.schema";

// ── Session types ──
export type { SessionHistoryResponse } from "@server/schemas/session.schema";

// ── Environment types ──
export type {
  EnvironmentInfo,
  EnvironmentListResponse,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
} from "@server/schemas/environment.schema";

// ── Task types ──
export type { TaskInfo, CreateTaskRequest, UpdateTaskRequest } from "@server/schemas/task.schema";

// ── Instance types ──
export type { InstanceInfo, SpawnInstanceFromEnvironmentRequest } from "@server/schemas/instance.schema";

// ── Knowledge types ──
export type {
  KnowledgeBaseInfo,
  KnowledgeResourceItem,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
  ImportKnowledgeUrlRequest,
} from "@server/schemas/knowledge.schema";

// ── Channel types ──
export type {
  ChannelBinding,
  ChannelProviderDescriptor,
  HermesStatus,
  CreateChannelBindingRequest,
} from "@server/schemas/channel.schema";

// ── File types ──
export type {
  FileListResponse,
  FileContent,
  FileUploadResponse,
  WriteFileRequest,
} from "@server/schemas/file.schema";

// ── Frontend-only types (not from backend schemas) ──

/** Session list item (returned by GET /web/sessions) */
export interface SessionListItem {
  id: string;
  title: string | null;
  status: string;
  environment_id: string | null;
  agent_name: string | null;
  source: string | null;
  created_at: number;
  updated_at: number;
}

/** Environment list item (returned by GET /web/environments) */
export interface EnvironmentListItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  agentConfigId: string | null;
  autoStart: boolean;
  secret: string;
  workspacePath: string;
  userId: string | null;
  organizationId: string | null;
  instances: Array<{
    id: string;
    port: number;
    status: string;
    session_id: string | null;
    instance_number: number;
  }>;
}

/** Organization with role (returned by POST /web/organizations action=list) */
export interface OrgWithRole {
  id: string;
  name: string;
  slug: string;
  role: string;
  metadata?: Record<string, unknown>;
}

/** Organization detail (returned by POST /web/organizations action=get) */
export interface OrgDetail extends OrgWithRole {
  members: Array<{
    id: string;
    userId: string;
    role: string;
    user?: { id: string; name: string; email: string };
  }>;
}

/** Workflow definition item (returned by POST /web/workflow-defs) */
export interface WorkflowDefItem {
  id: string;
  name: string;
  description: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  createdAt: string;
  updatedAt: string;
  organizationId: string;
}

/** Workflow version item */
export interface WorkflowVersionItem {
  id: string;
  version: string;
  status: string;
  createdAt: string;
}

/** Workflow engine types */
export type DAGStatus = "PENDING" | "RUNNING" | "SUSPENDED" | "FAILED" | "CANCELLED" | "ERROR" | "SUCCESS";
export type NodeStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "SKIPPED";

export interface DAGRunResult {
  runId: string;
  status: DAGStatus;
  summary: {
    run_id: string;
    workflow_name: string;
    status: DAGStatus;
    started_at: string;
    node_summary: { total: number; completed: number; failed: number; running: number };
  };
}

export interface DAGSnapshot {
  snapshot_id: string;
  run_id: string;
  node_states: Record<string, { status: NodeStatus; exit_code?: number }>;
  dag_status: DAGStatus;
}

export interface PendingApproval {
  runId: string;
  nodeId: string;
  approvalToken: string;
  expiresAt: string;
}

export interface DryRunResult {
  valid: boolean;
  issues: Array<{ type: "error" | "warning"; message: string; field?: string }>;
  executionPlan: { topologicalOrder: string[]; parallelGroups: string[][] };
}

export interface NodeOutput {
  stdout: string;
  json?: unknown;
  exit_code: number;
}

export interface DAGEvent {
  event_id: string;
  run_id: string;
  node_id?: string;
  timestamp: string;
  type: string;
  node_type?: string;
  metadata?: Record<string, unknown>;
}

export interface RunSummary {
  run_id: string;
  workflow_name: string;
  status: DAGStatus;
  started_at: string;
  completed_at?: string;
  node_summary: { total: number; completed: number; failed: number; running: number };
}

/** Ensure meta agent result */
export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
}

/** API Key item (from better-auth) */
export interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  start: string;
  createdAt: string;
  expiresAt?: string | null;
  metadata?: unknown;
}

/** API Key create result (includes plaintext key on creation) */
export interface ApiKeyCreateResult extends ApiKeyItem {
  key: string;
}

/** Config action-response wrapper (backend returns { success: true, data: T }) */
export interface ConfigResponse<T> {
  success: true;
  data: T;
}

/** Config error response */
export interface ConfigErrorResponse {
  success: false;
  error: { code: string; message: string };
}

/** Generic API error */
export interface ApiError {
  error: { type: string; message: string };
}
```

**Verification:** `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck:web` — should pass (new file only re-exports types, no callers yet).

---

### Task 2: Create typed fetch wrapper

**Files:**
- Create: `web/src/api/typed-client.ts`

This is the core module. It provides a typed `apiFetch` function and per-domain API namespaces that replace all `client.web.*` calls across the frontend.

- [ ] **Step 1: Create the typed fetch wrapper and all API namespace functions**

```typescript
// web/src/api/typed-client.ts
//
// Typed API client: replaces all Eden Treaty `client.web.*` calls.
// Each function has explicit request/response types — no `any`, no `unwrapEden`.

import type {
  ApiError,
  ApiKeyCreateResult,
  ApiKeyItem,
  ConfigResponse,
  DAGEvent,
  DAGRunResult,
  DAGSnapshot,
  DAGStatus,
  DryRunResult,
  EnsureMetaResult,
  EnvironmentListItem,
  NodeOutput,
  OrgDetail,
  OrgWithRole,
  PendingApproval,
  RunSummary,
  SessionListItem,
  WorkflowDefItem,
  WorkflowVersionItem,
} from "./types";

// ── Low-level typed fetch ──

class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function apiFetch<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let errData: ApiError | null = null;
    try {
      errData = await res.json();
    } catch {
      // JSON parse failed — use status text
    }
    const errType = errData?.error?.type ?? "unknown";
    const errMsg = errData?.error?.message ?? res.statusText;
    const errCode = (errData as Record<string, unknown>)?.code as string | undefined;
    throw new ApiRequestError(res.status, errType, errMsg, errCode);
  }

  return res.json() as Promise<T>;
}

/** Helper: unwrap { success: true, data: T } responses */
function unwrapConfig<T>(res: ConfigResponse<T> | ConfigErrorResponse): T {
  if ("success" in res && res.success === true) {
    return res.data;
  }
  const err = (res as ConfigErrorResponse).error;
  throw new ApiRequestError(400, err.code, err.message);
}

/** Helper: POST to action-dispatch routes */
async function postAction<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  return apiFetch<T>("POST", path, payload);
}

// ── Config API ──

export const configApi = {
  /** List providers */
  async listProviders(): Promise<{ providers: Array<import("./types").ProviderInfo> }> {
    return postAction("/web/config/providers", { action: "list" });
  },

  /** Get provider detail */
  async getProvider(name: string): Promise<import("./types").ProviderDetail> {
    return postAction("/web/config/providers", { action: "get", name });
  },

  /** Set provider */
  async setProvider(name: string, data: Record<string, unknown>): Promise<{ ok: boolean }> {
    return postAction("/web/config/providers", { action: "set", name, data });
  },

  /** Delete provider */
  async deleteProvider(name: string): Promise<{ ok: boolean }> {
    return postAction("/web/config/providers", { action: "delete", name });
  },

  /** Get model config */
  async getModelConfig(): Promise<import("./types").ModelConfig> {
    return postAction("/web/config/models", { action: "get" });
  },

  /** Set model */
  async setModel(data: Record<string, unknown>): Promise<{ ok: boolean }> {
    return postAction("/web/config/models", { action: "set", ...data });
  },

  /** List agents */
  async listAgents(): Promise<{ agents: import("./types").AgentInfo[] }> {
    return postAction("/web/config/agents", { action: "list" });
  },

  /** Get agent detail */
  async getAgent(name: string): Promise<import("./types").AgentDetail> {
    return postAction("/web/config/agents", { action: "get", name });
  },

  /** Set agent */
  async setAgent(name: string, data: Record<string, unknown>): Promise<{ ok: boolean }> {
    return postAction("/web/config/agents", { action: "set", name, data });
  },

  /** List skills */
  async listSkills(): Promise<import("./types").SkillInfo[]> {
    return postAction("/web/config/skills", { action: "list" });
  },

  /** Get skill detail */
  async getSkill(name: string): Promise<import("./types").SkillInfo> {
    return postAction("/web/config/skills", { action: "get", name });
  },

  /** Set skill */
  async setSkill(name: string, data: Record<string, unknown>): Promise<{ ok: boolean }> {
    return postAction("/web/config/skills", { action: "set", name, data });
  },

  /** List MCP servers */
  async listMcpServers(): Promise<import("./types").McpServerInfo[]> {
    return postAction("/web/config/mcp", { action: "list" });
  },

  /** Get MCP server detail */
  async getMcpServer(name: string): Promise<import("./types").McpServerDetail> {
    return postAction("/web/config/mcp", { action: "get", name });
  },

  /** Set MCP server */
  async setMcpServer(name: string, data: Record<string, unknown>): Promise<{ ok: boolean }> {
    return postAction("/web/config/mcp", { action: "set", name, data });
  },

  /** Delete MCP server */
  async deleteMcpServer(name: string): Promise<{ ok: boolean }> {
    return postAction("/web/config/mcp", { action: "delete", name });
  },

  /** Inspect MCP server */
  async inspectMcpServer(name: string): Promise<import("./types").McpInspectResult> {
    return postAction("/web/config/mcp", { action: "inspect", name });
  },
} as const;

// ── Sessions API ──

export const sessionsApi = {
  /** List sessions */
  async list(): Promise<SessionListItem[]> {
    return apiFetch("GET", "/web/sessions");
  },

  /** Get session detail */
  async get(id: string): Promise<SessionListItem> {
    return apiFetch("GET", `/web/sessions/${id}`);
  },

  /** Create session */
  async create(body: Record<string, string>): Promise<SessionListItem> {
    return apiFetch("POST", "/web/sessions", body);
  },

  /** Get session history */
  async history(id: string): Promise<{ events: unknown[] }> {
    return apiFetch("GET", `/web/sessions/${id}/history`);
  },

  /** Post event to session */
  async postEvent(id: string, event: Record<string, unknown>): Promise<{ status: string; event: unknown }> {
    return apiFetch("POST", `/web/sessions/${id}/events`, event);
  },

  /** Send control command */
  async control(id: string, cmd: Record<string, unknown>): Promise<{ status: string; event: unknown }> {
    return apiFetch("POST", `/web/sessions/${id}/control`, cmd);
  },

  /** Interrupt session */
  async interrupt(id: string): Promise<{ status: string }> {
    return apiFetch("POST", `/web/sessions/${id}/interrupt`);
  },
} as const;

// ── Environments API ──

export const environmentsApi = {
  /** List environments */
  async list(): Promise<EnvironmentListItem[]> {
    return apiFetch("GET", "/web/environments");
  },

  /** Get environment detail */
  async get(id: string): Promise<EnvironmentListItem & { secret: string }> {
    return apiFetch("GET", `/web/environments/${id}`);
  },

  /** Create environment */
  async create(data: {
    name: string;
    description?: string;
    agentConfigId?: string;
    autoStart?: boolean;
  }): Promise<EnvironmentListItem & { secret: string }> {
    return apiFetch("POST", "/web/environments", data);
  },

  /** Update environment */
  async update(
    id: string,
    data: {
      name?: string;
      description?: string | null;
      agentConfigId?: string | null;
      autoStart?: boolean;
    },
  ): Promise<EnvironmentListItem> {
    return apiFetch("PUT", `/web/environments/${id}`, data);
  },

  /** Delete environment */
  async delete(id: string): Promise<{ ok: boolean }> {
    return apiFetch("DELETE", `/web/environments/${id}`);
  },

  /** Enter environment */
  async enter(id: string, instanceNumber?: number): Promise<unknown> {
    return apiFetch("POST", `/web/environments/${id}/enter`, { instance_number: instanceNumber });
  },

  /** List environment instances */
  async listInstances(id: string): Promise<unknown[]> {
    return apiFetch("GET", `/web/environments/${id}/instances`);
  },

  /** List files in user directory */
  async listFiles(envId: string, path?: string): Promise<{ entries: unknown[] }> {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    return apiFetch("GET", `/web/environments/${envId}/user${query}`);
  },

  /** Read file content */
  async readFile(envId: string, filePath: string): Promise<{ name: string; content: string; path: string; size: number; encoding: string }> {
    return apiFetch("GET", `/web/environments/${envId}/user/${filePath}`);
  },
} as const;

// ── Instances API ──

export const instancesApi = {
  /** Spawn instance from environment */
  async spawnFromEnvironment(environmentId: string): Promise<unknown> {
    return apiFetch("POST", "/web/instances/from-environment", { environmentId });
  },

  /** Stop instance */
  async stop(instanceId: string): Promise<{ ok: boolean }> {
    return apiFetch("DELETE", `/web/instances/${instanceId}`);
  },
} as const;

// ── Tasks API ──

export const tasksApi = {
  /** List tasks */
  async list(): Promise<unknown[]> {
    return apiFetch("GET", "/web/tasks");
  },

  /** Get task detail */
  async get(id: string): Promise<unknown> {
    return apiFetch("GET", `/web/tasks/${id}`);
  },

  /** Create task */
  async create(data: Record<string, unknown>): Promise<unknown> {
    return apiFetch("POST", "/web/tasks", data);
  },

  /** Update task */
  async update(id: string, data: Record<string, unknown>): Promise<unknown> {
    return apiFetch("PUT", `/web/tasks/${id}`, data);
  },

  /** Delete task */
  async delete(id: string): Promise<{ ok: boolean }> {
    return apiFetch("DELETE", `/web/tasks/${id}`);
  },

  /** Toggle task enabled/disabled */
  async toggle(id: string): Promise<unknown> {
    return apiFetch("POST", `/web/tasks/${id}/toggle`);
  },

  /** Trigger task manually */
  async trigger(id: string): Promise<unknown> {
    return apiFetch("POST", `/web/tasks/${id}/trigger`);
  },

  /** List execution logs */
  async executionLogs(taskId: string): Promise<unknown[]> {
    return apiFetch("GET", `/web/tasks/${taskId}/execution-logs`);
  },
} as const;

// ── Organizations API ──

export const organizationsApi = {
  /** List organizations with roles */
  async list(): Promise<OrgWithRole[]> {
    const res = await postAction<ConfigResponse<OrgWithRole[]>>("/web/organizations", { action: "list" });
    return unwrapConfig(res);
  },

  /** Get organization detail */
  async get(organizationId: string): Promise<OrgDetail> {
    const res = await postAction<ConfigResponse<OrgDetail>>("/web/organizations", {
      action: "get",
      organizationId,
    });
    return unwrapConfig(res);
  },

  /** Create organization */
  async create(name: string, slug: string, description?: string): Promise<unknown> {
    const res = await postAction<ConfigResponse<unknown>>("/web/organizations", {
      action: "create",
      name,
      slug,
      description,
    });
    return unwrapConfig(res);
  },

  /** Update organization */
  async update(organizationId: string, data: Record<string, unknown>): Promise<unknown> {
    const res = await postAction<ConfigResponse<unknown>>("/web/organizations", {
      action: "update",
      organizationId,
      data,
    });
    return unwrapConfig(res);
  },

  /** Delete organization */
  async deleteOrg(organizationId: string): Promise<{ deleted: boolean }> {
    const res = await postAction<ConfigResponse<{ deleted: boolean }>>("/web/organizations", {
      action: "delete",
      organizationId,
    });
    return unwrapConfig(res);
  },

  /** Set active organization */
  async setActive(organizationId: string): Promise<void> {
    await postAction<ConfigResponse<unknown>>("/web/organizations", {
      action: "set-active",
      organizationId,
    });
  },

  /** List members */
  async listMembers(organizationId: string): Promise<unknown[]> {
    const res = await postAction<ConfigResponse<unknown[]>>("/web/organizations", {
      action: "list-members",
      organizationId,
    });
    return unwrapConfig(res);
  },

  /** Add member */
  async addMember(organizationId: string, email: string, role: string): Promise<unknown> {
    const res = await postAction<ConfigResponse<unknown>>("/web/organizations", {
      action: "add-member",
      organizationId,
      email,
      role,
    });
    return unwrapConfig(res);
  },

  /** Remove member */
  async removeMember(organizationId: string, userId: string): Promise<void> {
    await postAction<ConfigResponse<unknown>>("/web/organizations", {
      action: "remove-member",
      organizationId,
      userId,
    });
  },

  /** Update member role */
  async updateRole(organizationId: string, userId: string, role: string): Promise<void> {
    await postAction<ConfigResponse<unknown>>("/web/organizations", {
      action: "update-role",
      organizationId,
      userId,
      role,
    });
  },
} as const;

// ── API Keys ──

export const apiKeysApi = {
  /** List API keys */
  async list(): Promise<ApiKeyItem[]> {
    const res = await postAction<ConfigResponse<ApiKeyItem[]>>("/web/apiKeys", { action: "list" });
    return unwrapConfig(res);
  },

  /** Create API key */
  async create(name: string, expiresAt?: string, metadata?: unknown): Promise<ApiKeyCreateResult> {
    const res = await postAction<ConfigResponse<ApiKeyCreateResult>>("/web/apiKeys", {
      action: "create",
      name,
      expiresAt,
      metadata,
    });
    return unwrapConfig(res);
  },

  /** Delete API key */
  async deleteKey(id: string): Promise<{ deleted: boolean }> {
    const res = await postAction<ConfigResponse<{ deleted: boolean }>>("/web/apiKeys", {
      action: "delete",
      id,
    });
    return unwrapConfig(res);
  },

  /** Update API key */
  async update(id: string, name?: string): Promise<void> {
    await postAction<ConfigResponse<unknown>>("/web/apiKeys", { action: "update", id, name });
  },
} as const;

// ── Knowledge Bases API ──

export const knowledgeBasesApi = {
  /** List knowledge bases */
  async list(): Promise<unknown[]> {
    return apiFetch("GET", "/web/knowledgeBases");
  },

  /** Create knowledge base */
  async create(data: Record<string, unknown>): Promise<unknown> {
    return apiFetch("POST", "/web/knowledgeBases", data);
  },

  /** Get knowledge base detail */
  async get(id: string): Promise<unknown> {
    return apiFetch("GET", `/web/knowledgeBases/${id}`);
  },

  /** Update knowledge base */
  async update(id: string, data: Record<string, unknown>): Promise<unknown> {
    return apiFetch("PUT", `/web/knowledgeBases/${id}`, data);
  },

  /** Delete knowledge base */
  async delete(id: string): Promise<{ ok: boolean }> {
    return apiFetch("DELETE", `/web/knowledgeBases/${id}`);
  },

  /** List resources */
  async listResources(id: string): Promise<unknown[]> {
    return apiFetch("GET", `/web/knowledgeBases/${id}/resources`);
  },

  /** Import from URL */
  async importUrl(id: string, url: string): Promise<unknown> {
    return apiFetch("POST", `/web/knowledgeBases/${id}/resources/import-url`, { url });
  },
} as const;

// ── Channels API ──

export const channelsApi = {
  /** List channels */
  async list(): Promise<unknown[]> {
    return apiFetch("GET", "/web/channels");
  },

  /** List channel bindings */
  async listBindings(): Promise<unknown[]> {
    return apiFetch("GET", "/web/channels/bindings");
  },

  /** Create binding */
  async createBinding(data: Record<string, unknown>): Promise<unknown> {
    return apiFetch("POST", "/web/channels/bindings", data);
  },

  /** Hermes status */
  async hermesStatus(): Promise<unknown> {
    return apiFetch("GET", "/web/channels/hermes/status");
  },
} as const;

// ── Workflow Definitions API ──

export const workflowDefsApi = {
  /** Create workflow definition */
  async create(name: string, description?: string): Promise<WorkflowDefItem> {
    const res = await postAction<ConfigResponse<WorkflowDefItem>>("/web/workflow-defs", {
      action: "create",
      name,
      description,
    });
    return unwrapConfig(res);
  },

  /** Save draft YAML */
  async save(workflowId: string, yaml: string): Promise<void> {
    const res = await postAction<ConfigResponse<unknown>>("/web/workflow-defs", {
      action: "save",
      workflowId,
      yaml,
    });
    unwrapConfig(res);
  },

  /** Publish version */
  async publish(workflowId: string): Promise<WorkflowVersionItem> {
    const res = await postAction<ConfigResponse<WorkflowVersionItem>>("/web/workflow-defs", {
      action: "publish",
      workflowId,
    });
    return unwrapConfig(res);
  },

  /** List workflows */
  async list(): Promise<WorkflowDefItem[]> {
    const res = await postAction<ConfigResponse<WorkflowDefItem[]>>("/web/workflow-defs", { action: "list" });
    return unwrapConfig(res);
  },

  /** Get workflow */
  async get(workflowId: string): Promise<WorkflowDefItem> {
    const res = await postAction<ConfigResponse<WorkflowDefItem>>("/web/workflow-defs", {
      action: "get",
      workflowId,
    });
    return unwrapConfig(res);
  },

  /** Get versions */
  async getVersions(workflowId: string): Promise<WorkflowVersionItem[]> {
    const res = await postAction<ConfigResponse<WorkflowVersionItem[]>>("/web/workflow-defs", {
      action: "getVersions",
      workflowId,
    });
    return unwrapConfig(res);
  },

  /** Get version YAML */
  async getVersion(workflowId: string, version: string): Promise<{ yaml: string }> {
    const res = await postAction<ConfigResponse<{ yaml: string }>>("/web/workflow-defs", {
      action: "getVersion",
      workflowId,
      version,
    });
    return unwrapConfig(res);
  },

  /** Set latest version */
  async setLatest(workflowId: string, version: string): Promise<void> {
    const res = await postAction<ConfigResponse<unknown>>("/web/workflow-defs", {
      action: "setLatest",
      workflowId,
      version,
    });
    unwrapConfig(res);
  },

  /** Delete workflow */
  async delete(workflowId: string): Promise<void> {
    const res = await postAction<ConfigResponse<unknown>>("/web/workflow-defs", {
      action: "delete",
      workflowId,
    });
    unwrapConfig(res);
  },

  /** Update metadata */
  async updateMeta(workflowId: string, data: Record<string, unknown>): Promise<WorkflowDefItem> {
    const res = await postAction<ConfigResponse<WorkflowDefItem>>("/web/workflow-defs", {
      action: "updateMeta",
      workflowId,
      ...data,
    });
    return unwrapConfig(res);
  },

  /** Recover workflows */
  async recover(): Promise<string[]> {
    const res = await postAction<ConfigResponse<string[]>>("/web/workflow-defs", { action: "recover" });
    return unwrapConfig(res);
  },

  /** Apply recovery */
  async recoverApply(workflowIds: string[]): Promise<WorkflowDefItem[]> {
    const res = await postAction<ConfigResponse<WorkflowDefItem[]>>("/web/workflow-defs", {
      action: "recoverApply",
      workflowIds,
    });
    return unwrapConfig(res);
  },

  /** Restore version to draft */
  async restoreToDraft(workflowId: string, version: string): Promise<WorkflowDefItem> {
    const res = await postAction<ConfigResponse<WorkflowDefItem>>("/web/workflow-defs", {
      action: "restoreToDraft",
      workflowId,
      version,
    });
    return unwrapConfig(res);
  },
} as const;

// ── Workflow Engine API ──

export const workflowEngineApi = {
  /** Run workflow */
  async run(yaml: string, params?: Record<string, unknown>, workflowId?: string): Promise<DAGRunResult> {
    const res = await postAction<ConfigResponse<DAGRunResult>>("/web/workflow-engine", {
      action: "run",
      yaml,
      params,
      workflowId,
    });
    return unwrapConfig(res);
  },

  /** Dry run */
  async dryRun(yaml: string): Promise<DryRunResult> {
    const res = await postAction<ConfigResponse<DryRunResult>>("/web/workflow-engine", { action: "dryRun", yaml });
    return unwrapConfig(res);
  },

  /** Cancel run */
  async cancel(runId: string): Promise<void> {
    const res = await postAction<ConfigResponse<unknown>>("/web/workflow-engine", { action: "cancel", runId });
    unwrapConfig(res);
  },

  /** Get run status */
  async getRunStatus(runId: string): Promise<DAGSnapshot | null> {
    const res = await postAction<ConfigResponse<DAGSnapshot | null>>("/web/workflow-engine", {
      action: "getRunStatus",
      runId,
    });
    return unwrapConfig(res);
  },

  /** Get events */
  async getEvents(runId: string, nodeId?: string): Promise<DAGEvent[]> {
    const res = await postAction<ConfigResponse<DAGEvent[]>>("/web/workflow-engine", {
      action: "getEvents",
      runId,
      nodeId,
    });
    return unwrapConfig(res);
  },

  /** Get node output */
  async getOutput(runId: string, nodeId: string): Promise<NodeOutput | null> {
    const res = await postAction<ConfigResponse<NodeOutput | null>>("/web/workflow-engine", {
      action: "getOutput",
      runId,
      nodeId,
    });
    return unwrapConfig(res);
  },

  /** Get pending approvals */
  async getPendingApprovals(runId: string): Promise<PendingApproval[]> {
    const res = await postAction<ConfigResponse<PendingApproval[]>>("/web/workflow-engine", {
      action: "getPendingApprovals",
      runId,
    });
    return unwrapConfig(res);
  },

  /** Approve node */
  async approve(runId: string, nodeId: string, token: string, data?: unknown): Promise<void> {
    const res = await postAction<ConfigResponse<unknown>>("/web/workflow-engine", {
      action: "approve",
      runId,
      nodeId,
      token,
      data,
    });
    unwrapConfig(res);
  },

  /** List runs */
  async listRuns(): Promise<RunSummary[]> {
    const res = await postAction<ConfigResponse<RunSummary[]>>("/web/workflow-engine", { action: "listRuns" });
    return unwrapConfig(res);
  },

  /** Recover run */
  async recover(runId: string, yaml: string): Promise<DAGRunResult> {
    const res = await postAction<ConfigResponse<DAGRunResult>>("/web/workflow-engine", {
      action: "recover",
      runId,
      yaml,
    });
    return unwrapConfig(res);
  },

  /** Rerun from node */
  async rerunFrom(runId: string, yaml: string, fromNodeId: string, workflowId?: string): Promise<DAGRunResult> {
    const res = await postAction<ConfigResponse<DAGRunResult>>("/web/workflow-engine", {
      action: "rerunFrom",
      runId,
      yaml,
      fromNodeId,
      workflowId,
    });
    return unwrapConfig(res);
  },
} as const;

// ── Meta Agent API ──

export const metaAgentApi = {
  /** Ensure meta agent environment exists */
  async ensure(): Promise<EnsureMetaResult> {
    const res = await postAction<ConfigResponse<EnsureMetaResult>>("/web/meta-agent/ensure", {});
    return unwrapConfig(res);
  },
} as const;

// ── Re-export error class for consumer error handling ──

export { ApiRequestError };
```

**Verification:** `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck:web` — should compile (new file, no callers yet).

---

### Task 3: Update workflow API modules to use typed client

**Files:**
- Modify: `web/src/api/workflow-defs.ts`
- Modify: `web/src/api/workflow-engine.ts`
- Modify: `web/src/api/meta-agent.ts`

Replace all `client.web.*` + `unwrapEden` calls with the new typed API functions. These modules become thin re-exports or are deleted entirely.

- [ ] **Step 1: Replace `web/src/api/workflow-defs.ts`**

Replace the entire file content. The typed client already has all these functions, so this file re-exports from `typed-client.ts`:

```typescript
// web/src/api/workflow-defs.ts
//
// Workflow Definitions API — re-exported from typed-client.
// Consumers that import from this file get the same functions
// with full type safety.

export { workflowDefsApi } from "./typed-client";
export type { WorkflowDefItem, WorkflowVersionItem } from "./types";
```

- [ ] **Step 2: Replace `web/src/api/workflow-engine.ts`**

```typescript
// web/src/api/workflow-engine.ts
//
// Workflow Engine API — re-exported from typed-client.
// All types and functions are fully typed.

export { workflowEngineApi } from "./typed-client";
export type {
  DAGStatus,
  NodeStatus,
  EventType,
  NodeOutput,
  DAGEvent,
  DAGSnapshot,
  RunSummary,
  DAGRunResult,
  PendingApproval,
  DryRunResult,
} from "./types";
```

- [ ] **Step 3: Replace `web/src/api/meta-agent.ts`**

```typescript
// web/src/api/meta-agent.ts
//
// Meta Agent API — re-exported from typed-client.

export { metaAgentApi } from "./typed-client";
export type { EnsureMetaResult } from "./types";
```

**Verification:** `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck:web` — any errors from consumers of these modules will appear as missing exports. Fix import paths in the next tasks.

---

### Task 4: Update `web/src/api/client.ts` — remove Eden workaround

**Files:**
- Modify: `web/src/api/client.ts`

Remove `& { web: any }`, remove `unwrapEden`, remove `orgAction`. Keep SSE helper, `fetchUpload`, `uploadToPresignedUrl`, and UUID helpers (they don't depend on `client.web`). Add deprecation comments.

- [ ] **Step 1: Rewrite `web/src/api/client.ts`**

```typescript
// web/src/api/client.ts
//
// Legacy Eden Treaty client — DEPRECATED for HTTP calls.
// Use `typed-client.ts` (configApi, sessionsApi, etc.) for typed access.
//
// This file retains:
// - Eden Treaty client for potential future use
// - SSE helpers (Eden doesn't support SSE)
// - FormData upload helpers
// - UUID storage helpers

import { treaty } from "@elysiajs/eden";
import type { App } from "@server/index";

const _client = treaty<App>(typeof globalThis.window !== "undefined" ? globalThis.window.location.origin : "", {
  fetch: { credentials: "include" },
});

// Eden Treaty resolves to index signature when too many plugins are combined.
// Do NOT use `_client.web` — use typed-client.ts instead.
export const client = _client;

// --- SSE 辅助函数（Eden 不原生支持 SSE） ---

export function createSessionEventSource(sessionId: string): EventSource {
  const uuid = getUuid();
  const activeOrgId = localStorage.getItem("active_org_id");
  const params = new URLSearchParams();
  if (uuid) params.set("uuid", uuid);
  if (activeOrgId) params.set("activeOrganizationId", activeOrgId);
  const query = params.toString();
  const url = query ? `/web/sessions/${sessionId}/events?${query}` : `/web/sessions/${sessionId}/events`;
  return new EventSource(url, { withCredentials: true });
}

// --- FormData 上传辅助函数 ---

export async function fetchUpload<T>(path: string, formData: FormData): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) {
    const errInfo = data.error || { type: "unknown", message: res.statusText };
    const err = new Error(errInfo.message || errInfo.type) as Error & { code?: string; data?: unknown };
    if (errInfo && typeof errInfo === "object" && "code" in errInfo) {
      err.code = (errInfo as Record<string, unknown>).code as string;
    }
    if (data.data !== undefined) {
      err.data = data.data;
    }
    throw err;
  }
  return data as T;
}

// --- S3 Presigned URL 上传辅助函数 ---

/** 通过 presigned URL 直传文件到 S3（不经过 RCS 服务器中转） */
export async function uploadToPresignedUrl(url: string, file: File, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status}`);
}

// --- UUID 存储辅助函数 ---

const UUID_KEY = "rcs_uuid";

export function getUuid(): string {
  return localStorage.getItem(UUID_KEY) || "";
}

export function setUuid(uuid: string): void {
  localStorage.setItem(UUID_KEY, uuid);
}
```

**Verification:** `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck:web` — will show errors in files that still import `unwrapEden`, `orgAction`, or use `client.web.*`. These will be fixed in subsequent tasks.

---

### Task 5: Migrate config pages (AgentsPage, ModelsPage, SkillsPage, McpPage)

**Files:**
- Modify: `web/src/pages/AgentsPage.tsx`
- Modify: `web/src/pages/ModelsPage.tsx`
- Modify: `web/src/pages/SkillsPage.tsx`
- Modify: `web/src/pages/McpPage.tsx`

Replace `client.web.config.*` + `unwrapConfigData` with typed API imports.

- [ ] **Step 1: Update `AgentsPage.tsx`**

In all 4 files, the migration pattern is:
1. Remove `import { client } from "../api/client"` (or similar)
2. Remove `import { unwrapConfigData } from "../api/config-response"`
3. Add `import { configApi } from "../api/typed-client"`
4. Replace `client.web.config.agents.post({ action: "list" })` with `configApi.listAgents()`
5. Replace `.then((r: { data: unknown }) => { const d = unwrapConfigData<...>(r.data); ... })` with `.then((d) => d.agents)` (the typed client already unwraps)

Example for `AgentsPage.tsx` — find all instances of:
```typescript
client.web.config.agents.post({ action: "list" })
```
and replace with:
```typescript
configApi.listAgents()
```

Similarly for `get`, `set` actions. The response is already unwrapped — no more `unwrapConfigData`.

- [ ] **Step 2: Update `ModelsPage.tsx`**

Same pattern: replace `client.web.config.models.post({ action: ... })` with `configApi.getModelConfig()`, `configApi.setModel(data)`.

- [ ] **Step 3: Update `SkillsPage.tsx`**

Replace `client.web.config.skills.post({ action: ... })` with `configApi.listSkills()`, `configApi.getSkill(name)`, `configApi.setSkill(name, data)`.

- [ ] **Step 4: Update `McpPage.tsx`**

Replace `client.web.config.mcp.post({ action: ... })` with `configApi.listMcpServers()`, `configApi.getMcpServer(name)`, `configApi.setMcpServer(name, data)`, `configApi.deleteMcpServer(name)`, `configApi.inspectMcpServer(name)`.

**Verification:** `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck:web` — these 4 pages should have zero errors.

---

### Task 6: Migrate data-fetching pages (Dashboard, EnvironmentsPage, SessionDetail, TasksPage, KnowledgeBasesPage, ChannelsPage, ApiKeyManager, OrgsPage)

**Files:**
- Modify: `web/src/pages/Dashboard.tsx`
- Modify: `web/src/pages/EnvironmentsPage.tsx`
- Modify: `web/src/pages/SessionDetail.tsx`
- Modify: `web/src/pages/TasksPage.tsx`
- Modify: `web/src/pages/KnowledgeBasesPage.tsx`
- Modify: `web/src/pages/ChannelsPage.tsx`
- Modify: `web/src/pages/ApiKeyManager.tsx`
- Modify: `web/src/pages/OrgsPage.tsx`

- [ ] **Step 1: Update each page to import from typed-client**

Migration pattern per file:

**Dashboard.tsx:** Replace 7 parallel `client.web.*` calls:
```typescript
// Before:
client.web.environments.get().then((r: { data: unknown }) => ...)
client.web.sessions.get().then((r: { data: unknown }) => ...)
client.web.config.agents.post({ action: "list" }).then(...)
// ...

// After:
import { configApi, sessionsApi, environmentsApi, tasksApi } from "../api/typed-client";
environmentsApi.list()
sessionsApi.list()
configApi.listAgents()
```

**EnvironmentsPage.tsx:** Replace `client.web.environments.*` with `environmentsApi.list()`, `environmentsApi.get()`, `environmentsApi.create()`, `environmentsApi.update()`, `environmentsApi.delete()`.

**SessionDetail.tsx:** Replace `client.web.sessions.*` with `sessionsApi.get()`, `sessionsApi.history()`, `sessionsApi.postEvent()`, `sessionsApi.control()`, `sessionsApi.interrupt()`.

**TasksPage.tsx:** Replace `client.web.tasks.*` with `tasksApi.list()`, `tasksApi.get()`, `tasksApi.create()`, `tasksApi.update()`, `tasksApi.delete()`, `tasksApi.toggle()`, `tasksApi.trigger()`, `tasksApi.executionLogs()`.

**KnowledgeBasesPage.tsx:** Replace `client.web.knowledgeBases.*` with `knowledgeBasesApi.list()`, `knowledgeBasesApi.create()`, etc.

**ChannelsPage.tsx:** Replace `client.web.channels.*` with `channelsApi.list()`, `channelsApi.listBindings()`, `channelsApi.createBinding()`, `channelsApi.hermesStatus()`.

**ApiKeyManager.tsx:** Replace `client.web.apiKeys.*` with `apiKeysApi.list()`, `apiKeysApi.create()`, `apiKeysApi.deleteKey()`, `apiKeysApi.update()`.

**OrgsPage.tsx:** Replace `client.web.organizations.post` + `unwrapEden` with `organizationsApi.list()`, `organizationsApi.get()`, `organizationsApi.create()`, `organizationsApi.update()`, `organizationsApi.deleteOrg()`, `organizationsApi.listMembers()`, `organizationsApi.addMember()`, `organizationsApi.removeMember()`, `organizationsApi.updateRole()`.

**Verification:** `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck:web`

---

### Task 7: Migrate agent panel pages

**Files:**
- Modify: `web/src/pages/agent-panel/AgentCreateDialog.tsx`
- Modify: `web/src/pages/agent-panel/AgentSidebarTree.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentApiKeysPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentChannelsPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentMcpPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentModelsPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentSessionsPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentSkillsPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentTasksPage.tsx`

- [ ] **Step 1: Update each agent panel page**

Same migration pattern as Tasks 5-6. Each file needs:
1. Remove `import { client, unwrapEden } from "../../api/client"` or similar
2. Remove `import { unwrapConfigData } from "../../api/config-response"`
3. Add appropriate imports from `../../api/typed-client`
4. Replace all `client.web.*` calls with typed API functions

**Verification:** `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck:web`

---

### Task 8: Migrate shared components and lib

**Files:**
- Modify: `web/src/components/FilePickerDialog.tsx`
- Modify: `web/src/components/NewSessionDialog.tsx`
- Modify: `web/src/components/PermissionTab.tsx`
- Modify: `web/src/components/ACPMain.tsx`
- Modify: `web/src/components/agent-panel/FileTreeTab.tsx`
- Modify: `web/src/components/agent-panel/PreviewTab.tsx`
- Modify: `web/src/components/config/ModelConfigDialog.tsx`
- Modify: `web/src/contexts/OrgContext.tsx`
- Modify: `web/src/lib/rcs-chat-adapter.ts`
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 1: Update `OrgContext.tsx`**

```typescript
// Before:
import { client, unwrapEden } from "../api/client";
const res = await client.web.organizations.post({ action: "list" });
const list = unwrapEden<OrgWithRole[]>(res);
// ...
const res = await client.web.organizations.post({ action: "set-active", organizationId: orgId });
unwrapEden(res);

// After:
import { organizationsApi } from "../api/typed-client";
const list = await organizationsApi.list();
// ...
await organizationsApi.setActive(orgId);
```

- [ ] **Step 2: Update `FilePickerDialog.tsx`**

Replace `client.web.environments({ id: envId }).user.get(queryParams)` with `environmentsApi.listFiles(envId, path)`.

- [ ] **Step 3: Update `NewSessionDialog.tsx`**

Replace `client.web.sessions.post(body)` with `sessionsApi.create(body)`.

- [ ] **Step 4: Update `PermissionTab.tsx`**

Replace `client.web.config.skills.post(...)` with `configApi.setSkill(...)`, `configApi.listSkills()`.

- [ ] **Step 5: Update `ACPMain.tsx`**

Replace `client.web.sessions.*` calls with `sessionsApi.*` equivalents.

- [ ] **Step 6: Update `FileTreeTab.tsx` and `PreviewTab.tsx`**

Replace `client.web.environments({ id: envId })["user-file"].*` + `unwrapEden` with direct fetch calls or add user-file operations to the typed client.

For `FileTreeTab.tsx`:
```typescript
// Before:
import { client, fetchUpload, unwrapEden } from "../../api/client";
const res = await client.web.environments({ id: envId })["user-file"].tree.get();
const data = unwrapEden<{ paths?: string[] }>(res);

// After:
import { fetchUpload } from "../../api/client";
import { environmentsApi, ApiRequestError } from "../../api/typed-client";
// Add user-file operations to environmentsApi or call directly:
const res = await fetch(`/web/environments/${envId}/user-file/tree`, { credentials: "include" });
const data = await res.json();
```

For `PreviewTab.tsx`:
```typescript
// Before:
import { client, unwrapEden } from "../../api/client";
const res = await client.web.environments({ id: envId }).user({ path: normalized }).get();
const result = unwrapEden<{ content?: string; name?: string }>(res);

// After:
import { environmentsApi } from "../../api/typed-client";
const result = await environmentsApi.readFile(envId, normalized);
```

- [ ] **Step 7: Update `ModelConfigDialog.tsx`**

Replace `client.web.config.models.post(...)` with `configApi.setModel(...)`.

- [ ] **Step 8: Update `rcs-chat-adapter.ts`**

Replace `client.web.sessions.*` calls with `sessionsApi.*` equivalents:
```typescript
// Before:
const { data: historyData } = await client.web.sessions({ id: this.sessionId }).history.get();
await client.web.sessions({ id: this.sessionId }).events.post({ ... });
await client.web.sessions({ id: this.sessionId }).control.post({ ... });

// After:
import { sessionsApi } from "../api/typed-client";
const historyData = await sessionsApi.history(this.sessionId);
await sessionsApi.postEvent(this.sessionId, { ... });
await sessionsApi.control(this.sessionId, { ... });
```

- [ ] **Step 9: Update `WorkflowEditor.tsx`**

Replace `client.web.workflowDefs.*` + `unwrapEden` with `workflowDefsApi.*` from typed-client (these are re-exported from `workflow-defs.ts`).

**Verification:** `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck:web`

---

### Task 9: Remove `config-response.ts` and clean up imports

**Files:**
- Delete: `web/src/api/config-response.ts` (after all consumers are migrated)
- Verify: All `unwrapEden` and `unwrapConfigData` references are gone

- [ ] **Step 1: Verify no remaining references to removed utilities**

```bash
grep -rn "unwrapEden\|unwrapConfigData" --include="*.ts" --include="*.tsx" web/
```

Expected: zero matches (only `typed-client.ts` internal `unwrapConfig` should exist).

- [ ] **Step 2: Verify no remaining `client.web` references**

```bash
grep -rn "client\.web\." --include="*.ts" --include="*.tsx" web/
```

Expected: zero matches (SSE functions use direct `EventSource`, not `client.web`).

- [ ] **Step 3: Delete `config-response.ts`**

```bash
rm web/src/api/config-response.ts
```

**Verification:** `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck:web`

---

### Task 10: Final validation

**Files:**
- All frontend source files

- [ ] **Step 1: Run full type check**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck:web
```

Expected: zero errors.

- [ ] **Step 2: Run full lint check**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run lint
```

Expected: zero errors (no new `noExplicitAny` violations from the migration).

- [ ] **Step 3: Run full precheck**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

Expected: passes cleanly.

- [ ] **Step 4: Run frontend tests**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/
```

Expected: all tests pass (update test files if they reference `client.web` or `unwrapEden`).

- [ ] **Step 5: Build frontend**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
```

Expected: build succeeds.

- [ ] **Step 6: Count eliminated `any` usage**

```bash
grep -rn "unwrapEden\|unwrapConfigData\|client\.web\b" --include="*.ts" --include="*.tsx" web/src/ web/components/
```

Expected: zero matches. The entire type chain from backend schemas to frontend API calls is now explicit.

---

## Migration Checklist for Each File

For every file that uses `client.web.*`, the migration follows this pattern:

| Before | After |
|--------|-------|
| `import { client, unwrapEden } from "../api/client"` | `import { sessionsApi, configApi, ... } from "../api/typed-client"` |
| `import { unwrapConfigData } from "../api/config-response"` | (remove — typed client unwraps automatically) |
| `client.web.config.agents.post({ action: "list" })` | `configApi.listAgents()` |
| `client.web.config.models.post({ action: "get" })` | `configApi.getModelConfig()` |
| `client.web.sessions.get()` | `sessionsApi.list()` |
| `client.web.environments({ id }).get()` | `environmentsApi.get(id)` |
| `client.web.organizations.post({ action: "list" })` | `organizationsApi.list()` |
| `client.web.apiKeys.post({ action: "list" })` | `apiKeysApi.list()` |
| `client.web.tasks.get()` | `tasksApi.list()` |
| `client.web.knowledgeBases.get()` | `knowledgeBasesApi.list()` |
| `client.web.workflowDefs.post({ action: ... })` | `workflowDefsApi.create/save/list/etc()` |
| `client.web.workflowEngine.post({ action: ... })` | `workflowEngineApi.run/cancel/etc()` |
| `.then(r => unwrapEden<T>(r))` | (already typed, just `const result = await apiCall()`) |
| `.then(r => { const d = unwrapConfigData(r.data); ... })` | (already unwrapped, just use return value) |
