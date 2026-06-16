# @fenix/sdk 实现计划 — Part 4: 前端迁移 + 清理

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将所有前端 API 调用（Eden Treaty、`api<T>()`、`apiGet<T>()`、`apiPost<T>()`、`fetchUpload<T>()`、`orgAction<T>()`）硬切换为 `@fenix/sdk` 模块类调用，删除旧的 `web/src/api/client.ts`。

**Architecture:** 逐文件替换。每个文件先 import 对应的 SDK 模块类，替换 API 调用为 `const { data, error } = await api.method()`，处理错误收窄。全部替换完成后删除旧 client。

**Tech Stack:** @fenix/sdk, React, sonner toast

---

## 迁移映射表

以下是需要迁移的文件及其对应的 SDK 模块：

### Eden Treaty 调用（1 处生产代码 + 8 处测试）
| 文件 | 旧调用 | 新 SDK 模块 |
|------|--------|-------------|
| `web/components/config/ModelConfigDialog.tsx` | `client.web.config.models.post(...)` | `ModelApi` |
| `web/src/__tests__/api-client.test.ts` | `client.client.web.sessions.*` | 测试重写 |

### api/apiGet/apiPost 调用（57 处，15 个文件）
| 文件 | 涉及模块 |
|------|---------|
| `web/src/pages/AgentsPage.tsx` | `AgentApi` |
| `web/src/pages/agent-panel/AgentCreateDialog.tsx` | `AgentApi` |
| `web/src/pages/agent-panel/AgentConfigDialog.tsx` | `AgentApi` |
| `web/src/pages/TasksPage.tsx` | `TaskApi` |
| `web/src/pages/agent-panel/pages/AgentTasksPage.tsx` | `TaskApi` |
| `web/src/pages/EnvironmentsPage.tsx` | `EnvironmentApi`, `InstanceApi` |
| `web/src/pages/SessionDetail.tsx` | `ControlApi` |
| `web/src/lib/rcs-chat-adapter.ts` | `ControlApi` |
| `web/src/pages/SkillsPage.tsx` | `SkillConfigApi` |
| `web/src/pages/agent-panel/pages/AgentSkillsPage.tsx` | `SkillConfigApi` |
| `web/src/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx` | `KnowledgeBaseApi` |
| `web/src/pages/ModelsPage.tsx` | `ProviderApi` |
| `web/src/pages/agent-panel/pages/AgentModelsPage.tsx` | `ProviderApi` |
| `web/src/pages/McpPage.tsx` | `McpApi` |
| `web/src/pages/agent-panel/pages/AgentMcpPage.tsx` | `McpApi` |
| `web/src/components/agent-panel/FileTreeTab.tsx` | `UserFileApi` |
| `web/src/pages/agent-panel/pages/AgentChannelsPage.tsx` | `ChannelApi` |
| `web/src/pages/agent-panel/pages/AgentApiKeysPage.tsx` | `ApiKeyApi` |
| `web/src/api/workflow-engine.ts` | `WorkflowEngineApi` |
| `web/src/api/workflow-defs.ts` | `WorkflowDefApi` |

### fetchUpload 调用（13 处，9 个文件）
| 文件 | 涉及模块 |
|------|---------|
| `web/src/components/chat/ChatInput.tsx` | `FileApi` |
| `web/src/components/FilePickerDialog.tsx` | `FileApi` |
| `web/src/components/agent-panel/FileTreeTab.tsx` | `FileApi` |
| `web/src/pages/KnowledgeBasesPage.tsx` | `KnowledgeBaseApi` |
| `web/src/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx` | `KnowledgeBaseApi` |
| `web/src/pages/SkillsPage.tsx` | `SkillConfigApi` |
| `web/src/pages/agent-panel/pages/AgentSkillsPage.tsx` | `SkillConfigApi` |

### orgAction 调用（19 处，3 个文件）
| 文件 | 涉及模块 |
|------|---------|
| `web/src/contexts/OrgContext.tsx` | `OrganizationApi` |
| `web/src/pages/OrgsPage.tsx` | `OrganizationApi` |
| `web/src/pages/agent-panel/pages/AgentOrganizationsPage.tsx` | `OrganizationApi` |

---

### Task 20: 创建前端 SDK 实例工厂

**Files:**
- Create: `web/src/api/sdk.ts`

前端需要一个统一的 SDK 实例管理文件。模块类是无状态的（每个方法独立 fetch），可以复用实例。

- [ ] **Step 1: 创建 SDK 实例工厂**

```typescript
/**
 * sdk.ts — 前端 SDK 实例工厂
 *
 * 所有模块类无状态，可以安全复用单例。
 * 前端通过 `import { envApi, sessionApi } from "@/src/api/sdk"` 使用。
 */

import {
  EnvironmentApi,
  SessionApi,
  ControlApi,
  InstanceApi,
  TaskApi,
  FileApi,
  UserFileApi,
  KnowledgeBaseApi,
  ChannelApi,
  ProviderApi,
  ModelApi,
  AgentApi,
  SkillConfigApi,
  McpApi,
  OrganizationApi,
  ApiKeyApi,
  WorkflowEngineApi,
  WorkflowDefApi,
  MetaAgentApi,
  AuthApi,
  V1EnvironmentApi,
  V1SessionApi,
  V2CodeSessionApi,
  V2WorkerApi,
} from "@fenix/sdk";

// ── Web 模块 ──
export const envApi = new EnvironmentApi();
export const sessionApi = new SessionApi();
export const controlApi = new ControlApi();
export const instanceApi = new InstanceApi();
export const taskApi = new TaskApi();
export const fileApi = new FileApi();
export const userFileApi = new UserFileApi();
export const kbApi = new KnowledgeBaseApi();
export const channelApi = new ChannelApi();
export const providerApi = new ProviderApi();
export const modelApi = new ModelApi();
export const agentApi = new AgentApi();
export const skillConfigApi = new SkillConfigApi();
export const mcpApi = new McpApi();
export const orgApi = new OrganizationApi();
export const apiKeyApi = new ApiKeyApi();
export const workflowEngineApi = new WorkflowEngineApi();
export const workflowDefApi = new WorkflowDefApi();
export const metaAgentApi = new MetaAgentApi();
export const authApi = new AuthApi();

// ── V1/V2 模块（一般前端不直接使用，保留导出） ──
export const v1EnvApi = new V1EnvironmentApi();
export const v1SessionApi = new V1SessionApi();
export const v2CodeSessionApi = new V2CodeSessionApi();
export const v2WorkerApi = new V2WorkerApi();
```

- [ ] **Step 2: Commit**

```bash
git add web/src/api/sdk.ts
git commit -m "feat(sdk): 创建前端 SDK 实例工厂"
```

---

### Task 21: 迁移 Config 相关页面

**Files:**
- Modify: `web/src/pages/AgentsPage.tsx`
- Modify: `web/src/pages/agent-panel/AgentCreateDialog.tsx`
- Modify: `web/src/pages/agent-panel/AgentConfigDialog.tsx`
- Modify: `web/src/pages/ModelsPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentModelsPage.tsx`
- Modify: `web/src/pages/McpPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentMcpPage.tsx`
- Modify: `web/src/pages/SkillsPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentSkillsPage.tsx`
- Modify: `web/components/config/ModelConfigDialog.tsx`

迁移模式统一为：

**旧模式：**
```typescript
import { apiPost } from "@/src/api/client";
// ...
const result = await apiPost<AgentInfo[]>("/web/config/agents", { action: "list" });
```

**新模式：**
```typescript
import { agentApi } from "@/src/api/sdk";
// ...
const { data, error } = await agentApi.list();
if (error) { toast.error(error.message); return; }
// data 已收窄为 AgentInfo[]
```

- [ ] **Step 1: 逐文件替换**

每个文件的迁移步骤：
1. 移除 `import { apiPost, apiGet, api } from "@/src/api/client"` 中的已替换函数
2. 添加 `import { xxxApi } from "@/src/api/sdk"`
3. 替换所有 API 调用为 SDK 方法调用
4. 将 `try { const result = await apiPost<T>(...) } catch(e) { toast.error(e.message) }` 改为 `const { data, error } = await xxxApi.method(...); if (error) { toast.error(error.message); return; }`
5. 确保类型参数从 `apiPost<T>(...)` 移到 SDK 方法的返回值自动推导

`ModelConfigDialog.tsx` 的 Eden Treaty 调用替换：
```typescript
// 旧: const { data } = await client.web.config.models.post({ action: "set", [field]: value })
// 新: const { data, error } = await modelApi.set({ [field]: value })
```

- [ ] **Step 2: typecheck 验证**

Run: `bunx tsc --noEmit`
Expected: PASS（所有文件类型正确）

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/AgentsPage.tsx web/src/pages/agent-panel/ web/src/pages/ModelsPage.tsx web/src/pages/McpPage.tsx web/src/pages/SkillsPage.tsx web/components/config/ModelConfigDialog.tsx
git commit -m "refactor(web): 迁移 Config 相关页面到 @fenix/sdk"
```

---

### Task 22: 迁移 Environment/Instance/Session/Control 页面

**Files:**
- Modify: `web/src/pages/EnvironmentsPage.tsx`
- Modify: `web/src/pages/SessionDetail.tsx`
- Modify: `web/src/lib/rcs-chat-adapter.ts`

- [ ] **Step 1: EnvironmentsPage.tsx 迁移**

```typescript
// 旧:
import { apiGet, api, apiPost } from "@/src/api/client";
const instances = await apiGet(`/web/environments/${envId}/instances`);
await api("PUT", `/web/environments/${envId}`, payload);
await api("DELETE", `/web/instances/${instanceId}`);

// 新:
import { envApi, instanceApi } from "@/src/api/sdk";
const { data: instances, error } = await envApi.listInstances({ id: envId });
const { data, error } = await envApi.update({ id: envId }, payload);
const { data, error } = await instanceApi.delete({ id: instanceId });
```

- [ ] **Step 2: SessionDetail.tsx 迁移**

```typescript
// 旧: await api(`/web/sessions/${sessionId}/control`, "POST", { type: "resume" })
// 新: const { data, error } = await controlApi.control({ id: sessionId }, { type: "resume" })
```

- [ ] **Step 3: rcs-chat-adapter.ts 迁移**

```typescript
// 旧: await api(`/web/sessions/${sessionId}/events`, "POST", payload)
// 新: const { data, error } = await controlApi.sendEvent({ id: sessionId }, payload)
```

- [ ] **Step 4: typecheck + commit**

```bash
git add web/src/pages/EnvironmentsPage.tsx web/src/pages/SessionDetail.tsx web/src/lib/rcs-chat-adapter.ts
git commit -m "refactor(web): 迁移 Environment/Session/Control 页面到 SDK"
```

---

### Task 23: 迁移 Task/Knowledge/Channel/Org/File 页面

**Files:**
- Modify: `web/src/pages/TasksPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentTasksPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentChannelsPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentApiKeysPage.tsx`
- Modify: `web/src/pages/agent-panel/pages/AgentOrganizationsPage.tsx`
- Modify: `web/src/pages/OrgsPage.tsx`
- Modify: `web/src/contexts/OrgContext.tsx`
- Modify: `web/src/components/agent-panel/FileTreeTab.tsx`
- Modify: `web/src/components/chat/ChatInput.tsx`
- Modify: `web/src/components/FilePickerDialog.tsx`

迁移模式与 Task 21 相同。注意点：

- `orgAction<T>(action, params)` → `orgApi.list()`, `orgApi.create(body)`, `orgApi.setActive(orgId)` 等
- `fetchUpload<T>(path, formData)` → `fileApi.upload({ id, path }, formData)`, `kbApi.uploadResources({ id }, formData)` 等
- 文件路径中有动态参数的需要用 params 对象

- [ ] **Step 1: 逐文件替换**（同 Task 21 的迁移模式）

- [ ] **Step 2: typecheck + commit**

```bash
git add web/src/pages/ web/src/contexts/ web/src/components/
git commit -m "refactor(web): 迁移 Task/Knowledge/Channel/Org/File 页面到 SDK"
```

---

### Task 24: 迁移 Workflow API 模块文件

**Files:**
- Modify: `web/src/api/workflow-engine.ts`
- Modify: `web/src/api/workflow-defs.ts`

这两个文件是 API 封装层，直接替换为 SDK 调用。

- [ ] **Step 1: workflow-engine.ts 迁移**

```typescript
// 旧: export async function cancelWorkflowRun(runId: string) { return apiPost("/web/workflow-engine", { action: "cancel", runId }) }
// 新:
import { workflowEngineApi } from "@/src/api/sdk";
export async function cancelWorkflowRun(runId: string) {
  const { data, error } = await workflowEngineApi.cancel(runId);
  if (error) throw new Error(error.message);
  return data;
}
```

或者直接让消费方 import `workflowEngineApi` 使用，删除这个中间文件。

- [ ] **Step 2: workflow-defs.ts 迁移**（同上模式）

- [ ] **Step 3: typecheck + commit**

```bash
git add web/src/api/workflow-engine.ts web/src/api/workflow-defs.ts
git commit -m "refactor(web): 迁移 Workflow API 到 SDK"
```

---

### Task 25: 删除旧 client.ts + 清理 Eden 依赖

**Files:**
- Delete: `web/src/api/client.ts`（保留 `createSessionEventSource` 和辅助函数，或移至独立文件）
- Delete: `web/src/__tests__/eden-fetch-type-test.ts`
- Modify: `package.json`（移除 `@elysiajs/eden` 依赖）

- [ ] **Step 1: 提取需要保留的功能到独立文件**

`client.ts` 中有两个功能需要保留：
1. `createSessionEventSource()` — SSE 事件源创建
2. `getUuid()` / `setUuid()` — UUID 存储

将它们移到 `web/src/api/sse.ts`（如果已存在则合并）或新建 `web/src/api/helpers.ts`：

```typescript
// web/src/api/helpers.ts

const UUID_KEY = "rcs_uuid";

export function getUuid(): string {
  return localStorage.getItem(UUID_KEY) || "";
}

export function setUuid(uuid: string): void {
  localStorage.setItem(UUID_KEY, uuid);
}

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

/** S3 presigned URL 直传 */
export async function uploadToPresignedUrl(url: string, file: File, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status}`);
}
```

- [ ] **Step 2: 更新所有引用 `createSessionEventSource`、`getUuid`、`setUuid` 的文件**

搜索并替换 import 路径：
- `from "@/src/api/client"` → `from "@/src/api/helpers"`
- `from "../api/client"` → `from "../api/helpers"`（相对路径）

- [ ] **Step 3: 删除 `web/src/api/client.ts`**

```bash
git rm web/src/api/client.ts
```

- [ ] **Step 4: 删除测试文件**

```bash
git rm web/src/__tests__/eden-fetch-type-test.ts
```

- [ ] **Step 5: 更新 `web/src/__tests__/api-client.test.ts`**

这个测试文件使用了 Eden Treaty 调用。重写为 SDK 测试：

```typescript
import { describe, expect, it, mock, afterEach } from "bun:test";
import { SessionApi, ControlApi } from "@fenix/sdk";

// ... 用 SDK 模块类重写测试
```

- [ ] **Step 6: 考虑是否移除 `@elysiajs/eden` 依赖**

如果项目中不再有任何 Eden Treaty 使用，可以从 `package.json` 移除：

```bash
bun remove @elysiajs/eden
```

如果 `src/index.ts` 的 `export type App` 仍有其他用途（如后端测试），可以保留。

- [ ] **Step 7: 运行 precheck 确认一切正常**

Run: `bun run precheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(web): 删除旧 API client，完成 SDK 硬切换"
```

---

### Task 26: 最终验证

- [ ] **Step 1: 运行全部后端测试**

Run: `bun test src/__tests__/`
Expected: PASS

- [ ] **Step 2: 运行全部前端测试**

Run: `bun test web/src/__tests__/`
Expected: PASS

- [ ] **Step 3: 运行 precheck**

Run: `bun run precheck`
Expected: PASS

- [ ] **Step 4: 构建前端验证无编译错误**

Run: `bun run build:web`
Expected: PASS

- [ ] **Step 5: 手动冒烟测试**

启动 dev server 后验证：
1. 登录正常
2. 环境列表加载正常
3. 会话创建和消息发送正常
4. Config 页面（Providers/Models/Agents/Skills/MCP）CRUD 正常
5. 文件上传正常
6. 定时任务 CRUD 正常

- [ ] **Step 6: 最终 commit**

```bash
git commit --allow-empty -m "chore: @fenix/sdk 全量迁移完成，验证通过"
```

---

## Self-Review

**1. Spec coverage:**
- 所有 57 处 api/apiGet/apiPost 调用迁移 ✓
- 1 处 Eden Treaty 生产代码迁移 ✓
- 13 处 fetchUpload 调用迁移 ✓
- 19 处 orgAction 调用迁移 ✓
- SSE/EventSource 保留并提取到 helpers ✓
- 旧 client.ts 删除 ✓
- Eden 依赖评估移除 ✓
- 测试更新 ✓

**2. Placeholder scan:** 无 TBD/TODO。迁移步骤明确。

**3. Type consistency:**
- 所有 SDK 实例从 `web/src/api/sdk.ts` 统一导出 ✓
- 错误处理统一为 `{ data, error }` 模式 ✓
- 旧的 `unwrapConfigData<T>()` 不再需要（SDK BaseApi 已处理 `{ success, data }` 解包）✓
