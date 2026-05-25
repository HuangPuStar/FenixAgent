# Config Route Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `handle*` business logic from config route files into the Config Module service layer, so route files become thin dispatchers (~60 lines each).

**Architecture:** Each config route file currently mixes three concerns: body parsing, business logic (validation + service calls + field mapping), and Elysia route registration. We extract the business logic into existing service files under `src/services/config/`, keeping the existing `configSuccess`/`configError` response format. Route files retain only body extraction + `switch(action)` dispatch.

**Tech Stack:** Elysia, Drizzle ORM, existing `config-utils.ts` response helpers

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/services/config/agent-config.ts` | Agent CRUD + validation + DTO mapping (currently split between this file and route) |
| `src/services/config/provider.ts` | Provider CRUD + model sync + DTO mapping |
| `src/services/config/model.ts` | Model config get/set (user config) + available list cache |
| `src/services/config/mcp-server.ts` | MCP CRUD + test/inspect + DTO mapping |
| `src/services/config/skill.ts` | Skill CRUD + upload + DTO mapping |
| `src/routes/web/config/agents.ts` | Thin route: body extraction + dispatch |
| `src/routes/web/config/providers.ts` | Thin route: body extraction + dispatch |
| `src/routes/web/config/models.ts` | Thin route: body extraction + dispatch |
| `src/routes/web/config/mcp.ts` | Thin route: body extraction + dispatch |
| `src/routes/web/config/skills.ts` | Thin route: body extraction + dispatch |
| `src/__tests__/config-route-deepening.test.ts` | Integration tests for service-layer functions |

---

### Task 1: Extract Agent config handlers to service layer

**Files:**
- Modify: `src/services/config/agent-config.ts`
- Modify: `src/routes/web/config/agents.ts`

- [ ] **Step 1: Add DTO types and handler functions to agent-config.ts**

Append the following functions to `src/services/config/agent-config.ts`. These are extracted verbatim from `agents.ts`, adapted to use `configSuccess`/`configError`/`configNotFound`/`configValidationError` from `config-utils.ts`:

```typescript
import { configError, configNotFound, configSuccess, configValidationError } from "../config-utils";
import { listAgentKnowledgeBindingsById, syncAgentKnowledgeBindingsById } from "../agent-knowledge";
import { getUserConfig } from "./user-config";

/** Agent list item DTO (what the frontend expects) */
export interface AgentListItemDTO {
  id: string;
  name: string;
  builtIn: boolean;
  model: string | null;
  mode: string | null;
  description: string | null;
  color: string | null;
  knowledgeBaseCount: number;
}

/** Agent detail DTO */
export interface AgentDetailDTO {
  name: string;
  builtIn: boolean;
  model: string | null;
  prompt: string | null;
  steps: number | null;
  mode: string | null;
  permission: Record<string, unknown> | null;
  variant: string | null;
  temperature: number | null;
  top_p: number | null;
  disable: boolean;
  hidden: boolean;
  color: string | null;
  description: string | null;
  knowledge: Record<string, unknown> | null;
}

export async function handleAgentList(ctx: AuthContext) {
  const agents = await listAgentConfigs(ctx);
  const uc = await getUserConfig(ctx);
  const defaultAgent = uc.defaultAgent ?? null;
  const list: AgentListItemDTO[] = await Promise.all(
    agents.map(async (a) => ({
      id: a.id,
      name: a.name,
      builtIn: isBuiltInAgent(a.name),
      model: a.model ?? null,
      mode: a.mode ?? null,
      description: a.description ?? null,
      color: a.color ?? null,
      knowledgeBaseCount: (await listAgentKnowledgeBindingsById(a.id)).length,
    })),
  );
  return configSuccess({ default_agent: defaultAgent, agents: list });
}

export async function handleAgentGet(ctx: AuthContext, name: string) {
  const agent = await getAgentConfig(ctx, name);
  if (!agent) return configNotFound(`Agent '${name}' not found`);

  let permission = agent.permission ?? null;
  const tools = (agent as Record<string, unknown>).tools;
  if (permission == null && tools && typeof tools === "object" && !Array.isArray(tools)) {
    permission = toolsToPermission(tools as Record<string, boolean>);
  }

  return configSuccess({
    name,
    builtIn: isBuiltInAgent(name),
    model: agent.model ?? null,
    prompt: agent.prompt ?? null,
    steps: agent.steps ?? null,
    mode: agent.mode ?? null,
    permission,
    variant: agent.variant ?? null,
    temperature: agent.temperature ?? null,
    top_p: agent.topP ?? null,
    disable: agent.disable ?? false,
    hidden: agent.hidden ?? false,
    color: agent.color ?? null,
    description: agent.description ?? null,
    knowledge: normalizeKnowledgeConfig(agent.knowledge ?? null),
  });
}

export async function handleAgentSet(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  const validation = validateAgentData(data);
  if (validation) return configValidationError(validation);

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (AGENT_SETTABLE_FIELDS.includes(key as (typeof AGENT_SETTABLE_FIELDS)[number])) {
      filtered[key] = key === "knowledge" ? normalizeKnowledgeConfig(value) : value;
    }
  }

  const existing = await getAgentConfig(ctx, name);
  if (!existing) return configNotFound(`Agent '${name}' not found`);

  const updateData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filtered)) {
    if (key === "permission" && value == null) {
      updateData[key] = null;
    } else if (key === "knowledge" && value == null) {
      updateData[key] = null;
    } else if (key === "top_p") {
      updateData["topP"] = value;
    } else {
      updateData[key] = value;
    }
  }

  await updateAgentConfig(ctx, name, updateData);
  const updatedAgent = await getAgentConfig(ctx, name);
  if (updatedAgent) {
    await syncAgentKnowledgeBindingsById(
      ctx.organizationId,
      updatedAgent.id,
      filtered.knowledge as Parameters<typeof syncAgentKnowledgeBindingsById>[2],
    );
  }
  return configSuccess({ name, ...filtered });
}

export async function handleAgentCreate(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  if (!isValidResourceName(name)) {
    return configValidationError("Invalid agent name: must be 1-64 lowercase alphanumeric chars with single hyphens");
  }
  const validation = validateAgentData(data);
  if (validation) return configValidationError(validation);

  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (AGENT_SETTABLE_FIELDS.includes(key as (typeof AGENT_SETTABLE_FIELDS)[number])) {
      filtered[key] = key === "knowledge" ? normalizeKnowledgeConfig(value) : value;
    }
  }
  if (filtered.permission == null) delete filtered.permission;

  const pgData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filtered)) {
    if (key === "top_p") {
      pgData["topP"] = value;
    } else {
      pgData[key] = value;
    }
  }

  const existing = await getAgentConfig(ctx, name);
  if (existing) return configError("ALREADY_EXISTS", `Agent '${name}' already exists`);

  await createAgentConfig(ctx, name, pgData);
  const createdAgent = await getAgentConfig(ctx, name);
  if (createdAgent) {
    await syncAgentKnowledgeBindingsById(
      ctx.organizationId,
      createdAgent.id,
      filtered.knowledge as Parameters<typeof syncAgentKnowledgeBindingsById>[2],
    );
  }
  return configSuccess({ name });
}

export async function handleAgentDelete(ctx: AuthContext, name: string) {
  if (isBuiltInAgent(name)) {
    return configError("FORBIDDEN", `Cannot delete built-in agent '${name}'`);
  }
  const deleted = await deleteAgentConfig(ctx, name);
  if (!deleted) return configNotFound(`Agent '${name}' not found`);
  return configSuccess(null);
}

export async function handleAgentSetDefault(ctx: AuthContext, name: string) {
  const agent = await getAgentConfig(ctx, name);
  if (!agent) return configNotFound(`Agent '${name}' not found`);
  const { setUserConfig } = await import("./user-config");
  await setUserConfig(ctx, { defaultAgent: name });
  return configSuccess({ default_agent: name });
}
```

- [ ] **Step 2: Rewrite agents.ts route as thin dispatcher**

Replace the entire contents of `src/routes/web/config/agents.ts` with:

```typescript
import Elysia from "elysia";
import { authGuardPlugin } from "../../../plugins/auth";
import { ConfigBodySchema } from "../../../schemas/config.schema";
import { configError, configValidationError } from "../../../services/config-utils";
import {
  handleAgentCreate,
  handleAgentDelete,
  handleAgentGet,
  handleAgentList,
  handleAgentSet,
  handleAgentSetDefault,
} from "../../../services/config/agent-config";
import { loadOrgContext } from "../../../services/org-context";
import { InvalidKnowledgeBindingError } from "../../../services/agent-knowledge";

const app = new Elysia({ name: "web-config-agents", prefix: "/web" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
});

app.post(
  "/config/agents",
  async ({ store, body, error, request }: any) => {
    const authContext = await loadOrgContext(store.user!, request);
    if (!authContext)
      return error(500, {
        success: false,
        error: { code: "NO_ORG_CONTEXT", message: "Failed to load organization context" },
      });
    const authCtx = authContext;
    const b = (body as any) ?? {};
    const { action, name, data } = {
      action: b.action ?? "",
      name: b.name,
      data: b.data as Record<string, unknown> | undefined,
    };
    if (action !== "list" && !name) {
      return error(400, configValidationError("Missing 'name' field"));
    }
    try {
      switch (action) {
        case "list":
          return await handleAgentList(authCtx);
        case "get":
          return await handleAgentGet(authCtx, name!);
        case "set":
          return await handleAgentSet(authCtx, name!, data!);
        case "create":
          return await handleAgentCreate(authCtx, name!, data!);
        case "delete":
          return await handleAgentDelete(authCtx, name!);
        case "set_default":
          return await handleAgentSetDefault(authCtx, name!);
        default:
          return error(400, configValidationError(`Unknown action '${action}'`));
      }
    } catch (error_) {
      if (
        error_ instanceof InvalidKnowledgeBindingError ||
        (typeof error_ === "object" && error_ !== null && "code" in error_ && (error_ as { code?: string }).code === "INVALID_KNOWLEDGE_BINDINGS")
      ) {
        const message = error_ instanceof Error ? error_.message : "Knowledge binding invalid";
        return error(400, configError("INVALID_KNOWLEDGE_BINDINGS", message));
      }
      throw error_;
    }
  },
  { sessionAuth: true, body: "config-body", detail: { tags: ["Config"], summary: "Agent config management" } },
);

export default app;
```

- [ ] **Step 3: Verify build passes**

Run: `bun run build:web && bun run typecheck`
Expected: No errors

- [ ] **Step 4: Run existing tests**

Run: `bun test src/__tests__/config-agents.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/services/config/agent-config.ts src/routes/web/config/agents.ts
git commit -m "refactor: extract Agent config handlers to service layer"
```

---

### Task 2: Extract Provider config handlers to service layer

**Files:**
- Modify: `src/services/config/provider.ts`
- Modify: `src/routes/web/config/providers.ts`

- [ ] **Step 1: Add handler functions to provider.ts**

Append the following to `src/services/config/provider.ts`:

```typescript
import { configError, configNotFound, configSuccess, configValidationError, resolveApiKey, toKeyHint } from "../config-utils";
import { addModel, removeModel, updateModel, buildModelData } from "./model";
import { deleteProvider, getProvider, listProviders, upsertProvider } from "./provider";
import type { AuthContext } from "../../plugins/auth";
```

Then add the handler functions extracted from `providers.ts` (handleProviderList, handleProviderGet, handleProviderSet, handleProviderTest, handleProviderDelete, handleAddModel, handleUpdateModel, handleRemoveModel). Each function takes `AuthContext` and relevant params, returns the config response directly. Use the exact same logic as in the current route file.

Key functions:

```typescript
export async function handleProviderList(ctx: AuthContext) {
  const providers = await listProviders(ctx);
  const list = providers.map((p) => ({
    id: p.name,
    name: p.name,
    npm: p.npm ?? null,
    configured: !!p.apiKey,
    keyHint: toKeyHint(p.apiKey),
    baseURL: p.baseUrl ?? null,
    modelCount: p.modelCount,
  }));
  return configSuccess({ providers: list });
}

export async function handleProviderGet(ctx: AuthContext, name: string) {
  const p = await getProvider(ctx, name);
  if (!p) return configError("NOT_FOUND", `Provider '${name}' not found`);
  const models = (p.models ?? []).map((m) => ({
    id: m.modelId,
    name: m.displayName ?? m.modelId,
    modalities: m.modalities ?? null,
    limit: m.limitConfig ?? null,
    cost: m.cost ?? null,
  }));
  return configSuccess({
    id: name, name: p.name, npm: p.npm ?? null, keyHint: toKeyHint(p.apiKey),
    baseURL: p.baseUrl ?? null,
    options: {
      ...(p.baseUrl ? { baseURL: p.baseUrl } : {}),
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      ...(typeof p.extraOptions === "object" && p.extraOptions !== null ? (p.extraOptions as Record<string, unknown>) : {}),
    },
    models,
  });
}

export async function handleProviderSet(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  if (!name || typeof name !== "string") return configError("VALIDATION_ERROR", "Provider name is required");
  const existing = await getProvider(ctx, name);
  const apiKey = data.apiKey as string | undefined;
  const baseUrl = data.baseURL as string | undefined;
  const npm = (data.npm as string) ?? existing?.npm ?? "@ai-sdk/openai-compatible";
  const displayName = (data.name as string) ?? existing?.displayName ?? undefined;
  const knownKeys = new Set(["npm", "name", "baseURL", "apiKey", "models", "options"]);
  const extraOptions: Record<string, unknown> = {};
  if (typeof data.options === "object" && data.options !== null) {
    for (const [k, v] of Object.entries(data.options as Record<string, unknown>)) {
      if (k !== "apiKey" && k !== "baseURL") extraOptions[k] = v;
    }
  }
  for (const [k, v] of Object.entries(data)) {
    if (!knownKeys.has(k)) extraOptions[k] = v;
  }
  await upsertProvider(ctx, name, {
    displayName, npm, baseUrl, apiKey,
    extraOptions: Object.keys(extraOptions).length > 0 ? extraOptions : undefined,
  });
  if (data.models && typeof data.models === "object") {
    const providerRecord = await getProvider(ctx, name);
    if (providerRecord) {
      const incoming = data.models as Record<string, Record<string, unknown>>;
      for (const [modelId, modelCfg] of Object.entries(incoming)) {
        const existingModel = providerRecord.models?.find((m) => m.modelId === modelId);
        if (existingModel) {
          await updateModel(providerRecord.id, modelId, buildModelData(modelCfg));
        } else {
          await addModel(providerRecord.id, { modelId, ...buildModelData(modelCfg) });
        }
      }
    }
  }
  return configSuccess({ id: name, keyHint: toKeyHint(apiKey ?? existing?.apiKey) });
}

export async function handleProviderTest(ctx: AuthContext, name: string) {
  const p = await getProvider(ctx, name);
  if (!p) return configError("NOT_FOUND", `Provider '${name}' not found`);
  const apiKey = resolveApiKey(p.apiKey) ?? "";
  const baseURL = p.baseUrl ?? "https://api.anthropic.com";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const modelsPath = baseURL.endsWith("/v1") ? "/models" : "/v1/models";
    const res = await fetch(`${baseURL}${modelsPath}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        let detail = "";
        try { const body = await res.text(); detail = body.slice(0, 200); } catch {}
        return configError("CONFIG_READ_ERROR", `Auth failed (HTTP ${res.status})${detail ? ": " + detail : ""}`);
      }
      return configSuccess({ models: [], warning: `API reachable but models endpoint returned HTTP ${res.status}` });
    }
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (json.data ?? []).map((m) => m.id);
    return configSuccess({ models });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Connection failed";
    return configError("CONFIG_READ_ERROR", `Test failed: ${message}`);
  }
}

export async function handleProviderDelete(ctx: AuthContext, name: string) {
  const deleted = await deleteProvider(ctx, name);
  if (!deleted) return configError("NOT_FOUND", `Provider '${name}' not found`);
  return configSuccess(null);
}

export async function handleAddModel(ctx: AuthContext, providerName: string, data: Record<string, unknown>) {
  const modelId = data.modelId as string;
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");
  const p = await getProvider(ctx, providerName);
  if (!p) return configError("NOT_FOUND", `Provider '${providerName}' not found`);
  const existingModel = p.models?.find((m) => m.modelId === modelId);
  if (existingModel) return configError("VALIDATION_ERROR", `Model '${modelId}' already exists`);
  await addModel(p.id, { modelId, ...buildModelData(data) });
  return configSuccess({ modelId });
}

export async function handleUpdateModel(ctx: AuthContext, providerName: string, modelId: string, data: Record<string, unknown>) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");
  const p = await getProvider(ctx, providerName);
  if (!p) return configError("NOT_FOUND", `Provider '${providerName}' not found`);
  const existingModel = p.models?.find((m) => m.modelId === modelId);
  if (!existingModel) return configError("NOT_FOUND", `Model '${modelId}' not found`);
  await updateModel(p.id, modelId, buildModelData(data));
  return configSuccess({ modelId });
}

export async function handleRemoveModel(ctx: AuthContext, providerName: string, modelId: string) {
  if (!modelId) return configError("VALIDATION_ERROR", "modelId is required");
  const p = await getProvider(ctx, providerName);
  if (!p) return configError("NOT_FOUND", `Provider '${providerName}' not found`);
  const existingModel = p.models?.find((m) => m.modelId === modelId);
  if (!existingModel) return configError("NOT_FOUND", `Model '${modelId}' not found`);
  await removeModel(p.id, modelId);
  return configSuccess(null);
}
```

- [ ] **Step 2: Rewrite providers.ts as thin dispatcher**

Replace route body with thin dispatch calling the new service functions. The `invalidateAvailableCache` import moves to the provider module's `handleProviderSet`/`handleProviderDelete`/`handleAddModel`/`handleUpdateModel`/`handleRemoveModel` functions, and the route just calls the service. Route file becomes ~70 lines.

- [ ] **Step 3: Verify build + tests**

Run: `bun test src/__tests__/ && bun run typecheck`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/services/config/provider.ts src/routes/web/config/providers.ts
git commit -m "refactor: extract Provider config handlers to service layer"
```

---

### Task 3: Extract Model config handlers to service layer

**Files:**
- Modify: `src/services/config/model.ts`
- Modify: `src/routes/web/config/models.ts`

- [ ] **Step 1: Add handler functions to model.ts**

Move `buildAvailableList`, `getAvailable`, `handleGet`, `handleSet`, `handleRefresh` from `models.ts` route into `src/services/config/model.ts`. Move the `cachedAvailableByOrg` cache and `invalidateAvailableCache` there as well. Export `invalidateAvailableCache` for use by provider route.

```typescript
// In src/services/config/model.ts, add:
import { configError, configSuccess } from "../config-utils";
import { getUserConfig } from "./user-config";
import type { AuthContext } from "../../plugins/auth";

const cachedAvailableByOrg = new Map<string, { models: ModelEntry[]; updatedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateAvailableCache() { cachedAvailableByOrg.clear(); }

// ... (move buildAvailableList, getAvailable, handleGet, handleSet, handleRefresh from route)
```

- [ ] **Step 2: Rewrite models.ts as thin dispatcher**

Route becomes ~50 lines: just body extraction + switch/case calling `handleModelGet`/`handleModelSet`/`handleModelRefresh`.

- [ ] **Step 3: Update provider.ts import**

The `invalidateAvailableCache` import in providers route changes from `"./models"` (route) to `"../../../services/config/model"` (service). Provider service handlers that need invalidation call it directly.

- [ ] **Step 4: Verify build + tests**

Run: `bun test src/__tests__/ && bun run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/services/config/model.ts src/routes/web/config/models.ts src/routes/web/config/providers.ts
git commit -m "refactor: extract Model config handlers to service layer, move cache"
```

---

### Task 4: Extract MCP config handlers to service layer

**Files:**
- Modify: `src/services/config/mcp-server.ts`
- Modify: `src/routes/web/config/mcp.ts`

- [ ] **Step 1: Add handler functions to mcp-server.ts**

Move all `handle*` functions from `mcp.ts` route into `src/services/config/mcp-server.ts`. This includes: handleMcpList, handleMcpGet, handleMcpCreate, handleMcpUpdate, handleMcpDelete, handleMcpEnable, handleMcpDisable, handleMcpTest, handleMcpTestUrl, handleMcpInspect, handleMcpListTools. Import `inspectRemoteMcpServer` from the service layer.

- [ ] **Step 2: Rewrite mcp.ts as thin dispatcher**

Route becomes ~60 lines. Remove all local type definitions (McpLocalConfig, McpRemoteConfig, etc.) — these now live in the service module.

- [ ] **Step 3: Verify build + tests**

Run: `bun test src/__tests__/ && bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add src/services/config/mcp-server.ts src/routes/web/config/mcp.ts
git commit -m "refactor: extract MCP config handlers to service layer"
```

---

### Task 5: Extract Skill config handlers to service layer

**Files:**
- Modify: `src/services/config/skill.ts`
- Modify: `src/routes/web/config/skills.ts`

- [ ] **Step 1: Add handler functions to skill.ts**

Move all `handle*` functions from `skills.ts` route into `src/services/config/skill.ts`. This includes: handleSkillList, handleWorkspaceList, handleSkillGet, handleSkillSet, handleSkillDelete, handleSkillEnable, handleSkillDisable, handleSkillUpload. The upload handler needs `Request` access for `formData()` parsing — pass it as a parameter.

- [ ] **Step 2: Rewrite skills.ts as thin dispatcher**

Route becomes ~70 lines. Remove local `UploadManifestEntry` type and `SkillBody` type — these move to the service module.

- [ ] **Step 3: Verify build + tests**

Run: `bun test src/__tests__/config-skills-page.test.ts && bun run typecheck`

- [ ] **Step 4: Commit**

```bash
git add src/services/config/skill.ts src/routes/web/config/skills.ts
git commit -m "refactor: extract Skill config handlers to service layer"
```

---

### Task 6: Update config/index.ts barrel exports

**Files:**
- Modify: `src/services/config/index.ts`
- Modify: `src/services/config-pg.ts` (if needed for new exports)

- [ ] **Step 1: Add new handler exports to index.ts**

Add re-exports for all new `handle*` functions from each sub-module so route files can import from `../config/index` if desired. This is optional — routes can also import directly from the submodule.

- [ ] **Step 2: Verify full build + all tests**

Run: `bun test src/__tests__/ && bun run typecheck && bun run build:web`

- [ ] **Step 3: Commit**

```bash
git add src/services/config/index.ts src/services/config-pg.ts
git commit -m "refactor: update config barrel exports for deepened handlers"
```
