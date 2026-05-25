# @mothership/sdk 实现计划 — Part 3: SDK 模块类

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为所有 REST 路由组创建对应的 SDK 模块类（EnvironmentApi, SessionApi, TaskApi 等），继承 BaseApi，提供类型安全的方法。

**Architecture:** 每个模块是一个独立类，继承 `BaseApi`。方法返回 `ApiResult<T>`，使用 `params` 对象处理路径参数。Config 和 Workflow 的 action-based 路由按 action 拆分为独立方法。

**Tech Stack:** TypeScript, BaseApi (Part 1), Response Types (Part 2)

---

## File Structure

```
packages/sdk/src/
├── modules/
│   ├── environment.ts       # EnvironmentApi
│   ├── session.ts           # SessionApi + ControlApi
│   ├── instance.ts          # InstanceApi
│   ├── task.ts              # TaskApi
│   ├── file.ts              # FileApi + UserFileApi
│   ├── s3-file.ts           # S3FileApi
│   ├── knowledge.ts         # KnowledgeBaseApi
│   ├── channel.ts           # ChannelApi
│   ├── config.ts            # ProviderApi, ModelApi, AgentApi, SkillConfigApi, McpApi
│   ├── organization.ts      # OrganizationApi + ApiKeyApi
│   ├── workflow-engine.ts   # WorkflowEngineApi
│   ├── workflow-defs.ts     # WorkflowDefApi
│   ├── meta-agent.ts        # MetaAgentApi
│   ├── auth.ts              # AuthApi
│   ├── v1-environment.ts    # V1EnvironmentApi
│   ├── v1-session.ts        # V1SessionApi
│   ├── v2-code-session.ts   # V2CodeSessionApi
│   ├── v2-worker.ts         # V2WorkerApi
│   └── index.ts             # 统一导出所有模块类
```

---

### Task 12: EnvironmentApi

**Files:**
- Create: `packages/sdk/src/modules/environment.ts`

- [ ] **Step 1: 实现 EnvironmentApi**

```typescript
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  EnvironmentListResponse,
  EnvironmentInfo,
  EnvironmentDetailResponse,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
  UpdateEnvironmentResponse,
  DeleteEnvironmentResponse,
  EnterEnvironmentResponse,
  ListInstancesResponse,
} from "../types/schemas";

export class EnvironmentApi extends BaseApi {
  /** GET /web/environments — 列出团队环境 */
  async list(): Promise<ApiResult<EnvironmentListResponse[]>> {
    return this.get<EnvironmentListResponse[]>("/web/environments");
  }

  /** POST /web/environments — 注册新环境 */
  async create(body: CreateEnvironmentRequest): Promise<ApiResult<EnvironmentDetailResponse>> {
    return this.post<EnvironmentDetailResponse>("/web/environments", body);
  }

  /** GET /web/environments/:id — 获取环境详情（含 secret） */
  async get(params: { id: string }): Promise<ApiResult<EnvironmentDetailResponse>> {
    return this.get<EnvironmentDetailResponse>("/web/environments/:id", { params });
  }

  /** PUT /web/environments/:id — 更新环境元数据 */
  async update(
    params: { id: string },
    body: UpdateEnvironmentRequest,
  ): Promise<ApiResult<UpdateEnvironmentResponse>> {
    return this.put<UpdateEnvironmentResponse>("/web/environments/:id", body, { params });
  }

  /** DELETE /web/environments/:id — 删除环境 */
  async delete(params: { id: string }): Promise<ApiResult<DeleteEnvironmentResponse>> {
    return this.del<DeleteEnvironmentResponse>("/web/environments/:id", { params });
  }

  /** POST /web/environments/:id/enter — 进入环境 */
  async enter(
    params: { id: string },
    body?: { instance_number?: number },
  ): Promise<ApiResult<EnterEnvironmentResponse>> {
    return this.post<EnterEnvironmentResponse>("/web/environments/:id/enter", body, { params });
  }

  /** GET /web/environments/:id/instances — 列出环境的活动实例 */
  async listInstances(params: { id: string }): Promise<ApiResult<ListInstancesResponse>> {
    return this.get<ListInstancesResponse>("/web/environments/:id/instances", { params });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/sdk/src/modules/environment.ts
git commit -m "feat(sdk): 实现 EnvironmentApi 模块"
```

---

### Task 13: SessionApi + ControlApi

**Files:**
- Create: `packages/sdk/src/modules/session.ts`

- [ ] **Step 1: 实现 SessionApi + ControlApi**

```typescript
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  SessionListResponse,
  SessionResponse,
  SessionHistory,
  SendEventResponse,
  InterruptResponse,
  SessionEventPayload,
} from "../types/schemas";

/** 会话查询与管理 */
export class SessionApi extends BaseApi {
  /** GET /web/sessions — 列出团队会话 */
  async list(): Promise<ApiResult<SessionListResponse>> {
    return this.get<SessionListResponse>("/web/sessions");
  }

  /** GET /web/sessions/:id — 获取会话详情 */
  async get(params: { id: string }): Promise<ApiResult<SessionResponse>> {
    return this.get<SessionResponse>("/web/sessions/:id", { params });
  }

  /** GET /web/sessions/:id/history — 获取会话事件历史 */
  async history(params: { id: string }): Promise<ApiResult<SessionHistory>> {
    return this.get<SessionHistory>("/web/sessions/:id/history", { params });
  }
}

/** 会话控制（发送消息、中断） */
export class ControlApi extends BaseApi {
  /** POST /web/sessions/:id/events — 发送用户消息 */
  async sendEvent(
    params: { id: string },
    payload: SessionEventPayload,
  ): Promise<ApiResult<SendEventResponse>> {
    return this.post<SendEventResponse>("/web/sessions/:id/events", payload, { params });
  }

  /** POST /web/sessions/:id/control — 发送控制请求 */
  async control(
    params: { id: string },
    payload: SessionEventPayload,
  ): Promise<ApiResult<SendEventResponse>> {
    return this.post<SendEventResponse>("/web/sessions/:id/control", payload, { params });
  }

  /** POST /web/sessions/:id/interrupt — 中断会话 */
  async interrupt(params: { id: string }): Promise<ApiResult<InterruptResponse>> {
    return this.post<InterruptResponse>("/web/sessions/:id/interrupt", undefined, { params });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/sdk/src/modules/session.ts
git commit -m "feat(sdk): 实现 SessionApi + ControlApi 模块"
```

---

### Task 14: InstanceApi + TaskApi

**Files:**
- Create: `packages/sdk/src/modules/instance.ts`
- Create: `packages/sdk/src/modules/task.ts`

- [ ] **Step 1: 实现 InstanceApi**

```typescript
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  InstanceInfo,
  InstanceListResponse,
  DeleteInstanceResponse,
  SpawnInstanceFromEnvironmentRequest,
} from "../types/schemas";

export class InstanceApi extends BaseApi {
  /** POST /web/instances/from-environment — 从环境启动实例 */
  async spawn(body: SpawnInstanceFromEnvironmentRequest): Promise<ApiResult<InstanceInfo>> {
    return this.post<InstanceInfo>("/web/instances/from-environment", body);
  }

  /** GET /web/instances — 列出所有实例 */
  async list(): Promise<ApiResult<InstanceListResponse>> {
    return this.get<InstanceListResponse>("/web/instances");
  }

  /** DELETE /web/instances/:id — 停止并删除实例 */
  async delete(params: { id: string }): Promise<ApiResult<DeleteInstanceResponse>> {
    return this.del<DeleteInstanceResponse>("/web/instances/:id", { params });
  }
}
```

- [ ] **Step 2: 实现 TaskApi**

```typescript
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  TaskInfo,
  PaginatedLogs,
  CreateTaskRequest,
  UpdateTaskRequest,
  DeleteTaskResponse,
  ToggleTaskResponse,
  TriggerTaskResponse,
  ClearTaskLogsResponse,
} from "../types/schemas";

export class TaskApi extends BaseApi {
  /** GET /web/tasks — 列出定时任务 */
  async list(): Promise<ApiResult<TaskInfo[]>> {
    return this.get<TaskInfo[]>("/web/tasks");
  }

  /** POST /web/tasks — 创建定时任务 */
  async create(body: CreateTaskRequest): Promise<ApiResult<TaskInfo>> {
    return this.post<TaskInfo>("/web/tasks", body);
  }

  /** GET /web/tasks/:id — 获取任务详情 */
  async get(params: { id: string }): Promise<ApiResult<TaskInfo>> {
    return this.get<TaskInfo>("/web/tasks/:id", { params });
  }

  /** PUT /web/tasks/:id — 更新任务 */
  async update(params: { id: string }, body: UpdateTaskRequest): Promise<ApiResult<TaskInfo>> {
    return this.put<TaskInfo>("/web/tasks/:id", body, { params });
  }

  /** DELETE /web/tasks/:id — 删除任务 */
  async delete(params: { id: string }): Promise<ApiResult<DeleteTaskResponse>> {
    return this.del<DeleteTaskResponse>("/web/tasks/:id", { params });
  }

  /** POST /web/tasks/:id/toggle — 切换启用/禁用 */
  async toggle(params: { id: string }): Promise<ApiResult<ToggleTaskResponse>> {
    return this.post<ToggleTaskResponse>("/web/tasks/:id/toggle", undefined, { params });
  }

  /** POST /web/tasks/:id/trigger — 手动触发 */
  async trigger(params: { id: string }): Promise<ApiResult<TriggerTaskResponse>> {
    return this.post<TriggerTaskResponse>("/web/tasks/:id/trigger", undefined, { params });
  }

  /** GET /web/tasks/:id/logs — 获取执行日志（分页） */
  async logs(
    params: { id: string },
    query?: { page?: number; pageSize?: number },
  ): Promise<ApiResult<PaginatedLogs>> {
    return this.get<PaginatedLogs>("/web/tasks/:id/logs", { params, query });
  }

  /** DELETE /web/tasks/:id/logs — 清除执行日志 */
  async clearLogs(params: { id: string }): Promise<ApiResult<ClearTaskLogsResponse>> {
    return this.del<ClearTaskLogsResponse>("/web/tasks/:id/logs", { params });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/modules/instance.ts packages/sdk/src/modules/task.ts
git commit -m "feat(sdk): 实现 InstanceApi + TaskApi 模块"
```

---

### Task 15: FileApi + UserFileApi + S3FileApi

**Files:**
- Create: `packages/sdk/src/modules/file.ts`
- Create: `packages/sdk/src/modules/s3-file.ts`

- [ ] **Step 1: 实现 FileApi（工作区文件操作）**

```typescript
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  FileListResponse,
  FileContent,
  FileUploadResponse,
  FileWriteResult,
  OkResponse,
  TreeResponse,
  RenameResponse,
  MkdirResponse,
  BatchDeleteResponse,
} from "../types/schemas";

/** /web/environments/:id/user/* — 工作区文件读写 */
export class FileApi extends BaseApi {
  /** GET /web/environments/:id/user?path= — 列出目录 */
  async listDir(
    params: { id: string },
    query?: { path?: string },
  ): Promise<ApiResult<FileListResponse>> {
    return this.get<FileListResponse>("/web/environments/:id/user", { params, query });
  }

  /** GET /web/environments/:id/user/* — 读取文件内容 */
  async readFile(
    params: { id: string; path: string },
    query?: { preview?: boolean },
  ): Promise<ApiResult<FileContent>> {
    return this.get<FileContent>(`/web/environments/:id/user/${params.path}`, {
      params: { id: params.id },
      query,
    });
  }

  /** POST /web/environments/:id/user/* — 上传文件（FormData） */
  async upload(
    params: { id: string; path?: string },
    formData: FormData,
  ): Promise<ApiResult<FileUploadResponse>> {
    const url = params.path
      ? `/web/environments/:id/user/${params.path}`
      : "/web/environments/:id/user/";
    return this.upload<FileUploadResponse>(url, formData, {
      params: { id: params.id },
    });
  }

  /** PUT /web/environments/:id/user/* — 写入文件内容 */
  async writeFile(
    params: { id: string; path: string },
    body: { content: string },
  ): Promise<ApiResult<FileWriteResult>> {
    return this.put<FileWriteResult>(`/web/environments/:id/user/${params.path}`, body, {
      params: { id: params.id },
    });
  }

  /** DELETE /web/environments/:id/user/* — 删除文件 */
  async deleteFile(params: { id: string; path: string }): Promise<ApiResult<OkResponse>> {
    return this.del<OkResponse>(`/web/environments/:id/user/${params.path}`, {
      params: { id: params.id },
    });
  }
}

/** /web/environments/:id/user-file/* — 文件树操作（rename/mkdir/batch） */
export class UserFileApi extends BaseApi {
  /** GET /web/environments/:id/user-file/tree — 递归列出所有路径 */
  async tree(params: { id: string }): Promise<ApiResult<TreeResponse>> {
    return this.get<TreeResponse>("/web/environments/:id/user-file/tree", { params });
  }

  /** POST /web/environments/:id/user-file/rename — 重命名/移动 */
  async rename(
    params: { id: string },
    body: { oldPath: string; newPath: string },
  ): Promise<ApiResult<RenameResponse>> {
    return this.post<RenameResponse>("/web/environments/:id/user-file/rename", body, { params });
  }

  /** POST /web/environments/:id/user-file/mkdir — 创建目录 */
  async mkdir(params: { id: string }, body: { path: string }): Promise<ApiResult<MkdirResponse>> {
    return this.post<MkdirResponse>("/web/environments/:id/user-file/mkdir", body, { params });
  }

  /** DELETE /web/environments/:id/user-file/batch — 批量删除 */
  async batchDelete(
    params: { id: string },
    body: { paths: string[] },
  ): Promise<ApiResult<BatchDeleteResponse>> {
    return this.del<BatchDeleteResponse>("/web/environments/:id/user-file/batch", {
      params,
    });
  }
}
```

注意：`UserFileApi.batchDelete` 使用 DELETE + body。BaseApi 的 `del` 方法目前不发送 body。需要在此方法中使用 `fetch` 直接调用，或者在 BaseApi 中扩展 `del` 方法支持 body 参数。这里选择在 `del` 签名中添加可选 `body` 参数：

在 `packages/sdk/src/base.ts` 中修改 `del` 方法：

```typescript
/** DELETE 请求 */
protected async del<T>(path: string, options?: RequestOptions & { body?: unknown }): Promise<ApiResult<T>> {
  try {
    const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
    const response = await fetch(url, {
      method: "DELETE",
      headers: options?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      credentials: "include",
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    return this.handleResponse<T>(response);
  } catch (e) {
    return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
  }
}
```

同时更新 `UserFileApi.batchDelete`：

```typescript
/** DELETE /web/environments/:id/user-file/batch — 批量删除 */
async batchDelete(
  params: { id: string },
  body: { paths: string[] },
): Promise<ApiResult<BatchDeleteResponse>> {
  return this.del<BatchDeleteResponse>("/web/environments/:id/user-file/batch", {
    params,
    body,
  });
}
```

- [ ] **Step 2: 实现 S3FileApi**

```typescript
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  S3FileListResponse,
  S3PresignGetResponse,
  S3PresignPutResponse,
  S3UploadResponse,
  OkResponse,
} from "../types/schemas";

/** /web/s3/* — S3 文件操作 */
export class S3FileApi extends BaseApi {
  /** GET /web/s3/files — 列出会话文件 */
  async list(
    query: { sessionId: string; prefix?: string },
  ): Promise<ApiResult<S3FileListResponse>> {
    return this.get<S3FileListResponse>("/web/s3/files", { query });
  }

  /** GET /web/s3/files/presign — 获取下载预签名 URL */
  async presignGet(
    query: { sessionId: string; key: string },
  ): Promise<ApiResult<S3PresignGetResponse>> {
    return this.get<S3PresignGetResponse>("/web/s3/files/presign", { query });
  }

  /** POST /web/s3/files/presign — 获取上传预签名 URL */
  async presignPut(
    body: { sessionId: string; key: string; contentType: string },
  ): Promise<ApiResult<S3PresignPutResponse>> {
    return this.post<S3PresignPutResponse>("/web/s3/files/presign", body);
  }

  /** POST /web/s3/files/upload — 服务端上传（FormData） */
  async upload(
    query: { sessionId: string },
    formData: FormData,
  ): Promise<ApiResult<S3UploadResponse>> {
    return this.upload<S3UploadResponse>("/web/s3/files/upload", formData, { query });
  }

  /** DELETE /web/s3/files — 删除文件 */
  async deleteFile(
    body: { sessionId: string; key: string },
  ): Promise<ApiResult<OkResponse>> {
    return this.del<OkResponse>("/web/s3/files", { body });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/modules/file.ts packages/sdk/src/modules/s3-file.ts packages/sdk/src/base.ts
git commit -m "feat(sdk): 实现 FileApi + UserFileApi + S3FileApi 模块"
```

---

### Task 16: KnowledgeBaseApi + ChannelApi

**Files:**
- Create: `packages/sdk/src/modules/knowledge.ts`
- Create: `packages/sdk/src/modules/channel.ts`

- [ ] **Step 1: 实现 KnowledgeBaseApi**

```typescript
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  KnowledgeBaseInfo,
  KnowledgeBaseListResponse,
  KnowledgeResourceItem,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
  DeleteKnowledgeBaseResponse,
  UploadKnowledgeResourcesResponse,
  ImportKnowledgeUrlResponse,
  DeleteKnowledgeResourceResponse,
} from "../types/schemas";

export class KnowledgeBaseApi extends BaseApi {
  /** GET /web/knowledgeBases — 列出知识库 */
  async list(): Promise<ApiResult<KnowledgeBaseListResponse>> {
    return this.get<KnowledgeBaseListResponse>("/web/knowledgeBases");
  }

  /** POST /web/knowledgeBases — 创建知识库 */
  async create(body: CreateKnowledgeBaseRequest): Promise<ApiResult<KnowledgeBaseInfo>> {
    return this.post<KnowledgeBaseInfo>("/web/knowledgeBases", body);
  }

  /** GET /web/knowledgeBases/:id — 获取知识库详情 */
  async get(params: { id: string }): Promise<ApiResult<KnowledgeBaseInfo>> {
    return this.get<KnowledgeBaseInfo>("/web/knowledgeBases/:id", { params });
  }

  /** PATCH /web/knowledgeBases/:id — 更新知识库 */
  async update(
    params: { id: string },
    body: UpdateKnowledgeBaseRequest,
  ): Promise<ApiResult<KnowledgeBaseInfo>> {
    return this.patch<KnowledgeBaseInfo>("/web/knowledgeBases/:id", body, { params });
  }

  /** DELETE /web/knowledgeBases/:id — 删除知识库 */
  async delete(params: { id: string }): Promise<ApiResult<DeleteKnowledgeBaseResponse>> {
    return this.del<DeleteKnowledgeBaseResponse>("/web/knowledgeBases/:id", { params });
  }

  /** POST /web/knowledgeBases/:id/resources/upload — 上传资源（FormData） */
  async uploadResources(
    params: { id: string },
    formData: FormData,
  ): Promise<ApiResult<UploadKnowledgeResourcesResponse>> {
    return this.upload<UploadKnowledgeResourcesResponse>(
      "/web/knowledgeBases/:id/resources/upload",
      formData,
      { params },
    );
  }

  /** POST /web/knowledgeBases/:id/resources/url — 从 URL 导入 */
  async importUrl(
    params: { id: string },
    body: { url: string; sourceName?: string },
  ): Promise<ApiResult<ImportKnowledgeUrlResponse>> {
    return this.post<ImportKnowledgeUrlResponse>("/web/knowledgeBases/:id/resources/url", body, {
      params,
    });
  }

  /** GET /web/knowledgeBases/:id/resources — 列出资源 */
  async listResources(
    params: { id: string },
  ): Promise<ApiResult<KnowledgeResourceItem[]>> {
    return this.get<KnowledgeResourceItem[]>("/web/knowledgeBases/:id/resources", { params });
  }

  /** DELETE /web/knowledgeBases/:id/resources/:resourceId — 删除资源 */
  async deleteResource(
    params: { id: string; resourceId: string },
  ): Promise<ApiResult<DeleteKnowledgeResourceResponse>> {
    return this.del<DeleteKnowledgeResourceResponse>(
      "/web/knowledgeBases/:id/resources/:resourceId",
      { params },
    );
  }
}
```

- [ ] **Step 2: 实现 ChannelApi**

```typescript
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  ChannelProviderListResponse,
  HermesStatus,
  ChannelBindingListResponse,
  ChannelBinding,
  CreateChannelBindingRequest,
  CreateChannelBindingResponse,
  DeleteChannelBindingResponse,
  UpdateChannelBindingResponse,
} from "../types/schemas";

export class ChannelApi extends BaseApi {
  /** GET /web/channels/providers — 列出通道供应商 */
  async listProviders(): Promise<ApiResult<ChannelProviderListResponse>> {
    return this.get<ChannelProviderListResponse>("/web/channels/providers");
  }

  /** GET /web/channels/hermes/status — Hermes 状态 */
  async hermesStatus(): Promise<ApiResult<HermesStatus>> {
    return this.get<HermesStatus>("/web/channels/hermes/status");
  }

  /** GET /web/channels/bindings — 列出通道绑定 */
  async listBindings(): Promise<ApiResult<ChannelBindingListResponse>> {
    return this.get<ChannelBindingListResponse>("/web/channels/bindings");
  }

  /** POST /web/channels/bindings — 创建通道绑定 */
  async createBinding(
    body: CreateChannelBindingRequest,
  ): Promise<ApiResult<CreateChannelBindingResponse>> {
    return this.post<CreateChannelBindingResponse>("/web/channels/bindings", body);
  }

  /** DELETE /web/channels/bindings/:id — 删除通道绑定 */
  async deleteBinding(
    params: { id: string },
  ): Promise<ApiResult<DeleteChannelBindingResponse>> {
    return this.del<DeleteChannelBindingResponse>("/web/channels/bindings/:id", { params });
  }

  /** PATCH /web/channels/bindings/:id — 更新通道绑定 */
  async updateBinding(
    params: { id: string },
    body: Partial<Pick<ChannelBinding, "platform" | "chatId" | "agentId" | "enabled">>,
  ): Promise<ApiResult<UpdateChannelBindingResponse>> {
    return this.patch<UpdateChannelBindingResponse>("/web/channels/bindings/:id", body, {
      params,
    });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/modules/knowledge.ts packages/sdk/src/modules/channel.ts
git commit -m "feat(sdk): 实现 KnowledgeBaseApi + ChannelApi 模块"
```

---

### Task 17: Config 模块（Provider/Model/Agent/Skill/Mcp）

**Files:**
- Create: `packages/sdk/src/modules/config.ts`

Config 路由是 action-based，每个 action 返回不同结构。统一用 `{ success, data }` 解包。

- [ ] **Step 1: 实现 Config 模块类**

```typescript
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  ProviderInfo,
  ProviderDetail,
  ModelEntry,
  ModelConfig,
  AgentInfo,
  AgentDetail,
  SkillInfo,
  McpServerInfo,
  McpServerDetail,
  McpToolInfo,
  McpInspectResult,
} from "../types/schemas";

/** Config 模块通用 action body */
interface ConfigActionBody {
  action: string;
  [key: string]: unknown;
}

/** POST /web/config/providers — Provider 管理 */
export class ProviderApi extends BaseApi {
  async list(): Promise<ApiResult<ProviderInfo[]>> {
    return this.post<ProviderInfo[]>("/web/config/providers", { action: "list" });
  }
  async get(name: string): Promise<ApiResult<ProviderDetail>> {
    return this.post<ProviderDetail>("/web/config/providers", { action: "get", name });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<ProviderInfo>> {
    return this.post<ProviderInfo>("/web/config/providers", { action: "set", name, data });
  }
  async test(name: string): Promise<ApiResult<{ success: boolean; error?: string }>> {
    return this.post("/web/config/providers", { action: "test", name });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/providers", { action: "delete", name });
  }
  async addModel(
    name: string,
    modelData: Record<string, unknown>,
  ): Promise<ApiResult<ModelEntry>> {
    return this.post("/web/config/providers", { action: "add_model", name, data: modelData });
  }
  async updateModel(
    name: string,
    modelData: Record<string, unknown>,
  ): Promise<ApiResult<ModelEntry>> {
    return this.post("/web/config/providers", { action: "update_model", name, data: modelData });
  }
  async removeModel(name: string, modelId: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/providers", { action: "remove_model", name, modelId });
  }
}

/** POST /web/config/models — Model 配置 */
export class ModelApi extends BaseApi {
  async get(): Promise<ApiResult<ModelConfig>> {
    return this.post<ModelConfig>("/web/config/models", { action: "get" });
  }
  async set(data: Record<string, unknown>): Promise<ApiResult<ModelConfig>> {
    return this.post<ModelConfig>("/web/config/models", { action: "set", data });
  }
  async refresh(): Promise<ApiResult<ModelEntry[]>> {
    return this.post<ModelEntry[]>("/web/config/models", { action: "refresh" });
  }
}

/** POST /web/config/agents — Agent 管理 */
export class AgentApi extends BaseApi {
  async list(): Promise<ApiResult<AgentInfo[]>> {
    return this.post<AgentInfo[]>("/web/config/agents", { action: "list" });
  }
  async get(name: string): Promise<ApiResult<AgentDetail>> {
    return this.post<AgentDetail>("/web/config/agents", { action: "get", name });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<AgentDetail>> {
    return this.post<AgentDetail>("/web/config/agents", { action: "set", name, data });
  }
  async create(name: string, data: Record<string, unknown>): Promise<ApiResult<AgentDetail>> {
    return this.post<AgentDetail>("/web/config/agents", { action: "create", name, data });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/agents", { action: "delete", name });
  }
  async setDefault(name: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/agents", { action: "set_default", name });
  }
}

/** POST /web/config/skills — Skill 管理 */
export class SkillConfigApi extends BaseApi {
  async list(): Promise<ApiResult<SkillInfo[]>> {
    return this.post<SkillInfo[]>("/web/config/skills", { action: "list" });
  }
  async get(name: string): Promise<ApiResult<SkillInfo>> {
    return this.post<SkillInfo>("/web/config/skills", { action: "get", name });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<SkillInfo>> {
    return this.post<SkillInfo>("/web/config/skills", { action: "set", name, data });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/skills", { action: "delete", name });
  }
  async upload(formData: FormData): Promise<ApiResult<SkillInfo>> {
    return this.upload<SkillInfo>("/web/config/skills/upload", formData);
  }
}

/** POST /web/config/mcp — MCP 服务器管理 */
export class McpApi extends BaseApi {
  async list(): Promise<ApiResult<McpServerInfo[]>> {
    return this.post<McpServerInfo[]>("/web/config/mcp", { action: "list" });
  }
  async get(name: string): Promise<ApiResult<McpServerDetail>> {
    return this.post<McpServerDetail>("/web/config/mcp", { action: "get", name });
  }
  async create(name: string, data: Record<string, unknown>): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp", { action: "create", name, data });
  }
  async set(name: string, data: Record<string, unknown>): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp", { action: "set", name, data });
  }
  async delete(name: string): Promise<ApiResult<boolean>> {
    return this.post("/web/config/mcp", { action: "delete", name });
  }
  async enable(name: string): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp", { action: "enable", name });
  }
  async disable(name: string): Promise<ApiResult<McpServerInfo>> {
    return this.post<McpServerInfo>("/web/config/mcp", { action: "disable", name });
  }
  async test(name: string): Promise<ApiResult<{ success: boolean; error?: string }>> {
    return this.post("/web/config/mcp", { action: "test", name });
  }
  async testUrl(url: string): Promise<ApiResult<{ success: boolean; error?: string }>> {
    return this.post("/web/config/mcp", { action: "test_url", url });
  }
  async inspect(name: string): Promise<ApiResult<McpInspectResult>> {
    return this.post<McpInspectResult>("/web/config/mcp", { action: "inspect", name });
  }
  async listTools(name: string): Promise<ApiResult<McpToolInfo[]>> {
    return this.post<McpToolInfo[]>("/web/config/mcp", { action: "list_tools", name });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/sdk/src/modules/config.ts
git commit -m "feat(sdk): 实现 Config 模块（Provider/Model/Agent/Skill/Mcp）"
```

---

### Task 18: OrganizationApi + WorkflowApi + V1/V2 模块

**Files:**
- Create: `packages/sdk/src/modules/organization.ts`
- Create: `packages/sdk/src/modules/workflow-engine.ts`
- Create: `packages/sdk/src/modules/workflow-defs.ts`
- Create: `packages/sdk/src/modules/meta-agent.ts`
- Create: `packages/sdk/src/modules/auth.ts`
- Create: `packages/sdk/src/modules/v1-environment.ts`
- Create: `packages/sdk/src/modules/v1-session.ts`
- Create: `packages/sdk/src/modules/v2-code-session.ts`
- Create: `packages/sdk/src/modules/v2-worker.ts`

- [ ] **Step 1: 实现 OrganizationApi + ApiKeyApi**

```typescript
// packages/sdk/src/modules/organization.ts
import { BaseApi } from "../base";
import type { ApiResult } from "../result";

/** 组织相关响应类型（better-auth 返回结构） */
interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

interface OrgDetail extends OrgInfo {
  members: Array<{
    id: string;
    userId: string;
    role: string;
    user: { id: string; name: string; email: string };
  }>;
}

interface OrgMember {
  id: string;
  userId: string;
  role: string;
}

interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  expiresAt: Date | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** POST /web/organizations — 组织管理 */
export class OrganizationApi extends BaseApi {
  async list(): Promise<ApiResult<OrgInfo[]>> {
    return this.post<OrgInfo[]>("/web/organizations", { action: "list" });
  }
  async get(organizationId: string): Promise<ApiResult<OrgDetail>> {
    return this.post<OrgDetail>("/web/organizations", { action: "get", organizationId });
  }
  async getFull(organizationId: string): Promise<ApiResult<OrgDetail>> {
    return this.post<OrgDetail>("/web/organizations", { action: "get-full", organizationId });
  }
  async create(body: { name: string; slug?: string }): Promise<ApiResult<OrgInfo>> {
    return this.post<OrgInfo>("/web/organizations", { action: "create", ...body });
  }
  async update(
    organizationId: string,
    body: { name?: string; slug?: string },
  ): Promise<ApiResult<OrgInfo>> {
    return this.post<OrgInfo>("/web/organizations", { action: "update", organizationId, ...body });
  }
  async delete(organizationId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/organizations", { action: "delete", organizationId });
  }
  async setActive(organizationId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/organizations", { action: "set-active", organizationId });
  }
  async listMembers(organizationId: string): Promise<ApiResult<OrgMember[]>> {
    return this.post<OrgMember[]>("/web/organizations", { action: "list-members", organizationId });
  }
  async addMember(
    organizationId: string,
    body: { userId: string; role: string },
  ): Promise<ApiResult<OrgMember>> {
    return this.post<OrgMember>("/web/organizations", {
      action: "add-member",
      organizationId,
      ...body,
    });
  }
  async removeMember(organizationId: string, memberId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/organizations", {
      action: "remove-member",
      organizationId,
      memberId,
    });
  }
  async updateRole(
    organizationId: string,
    memberId: string,
    role: string,
  ): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/organizations", {
      action: "update-role",
      organizationId,
      memberId,
      role,
    });
  }
}

/** POST /web/apiKeys — API Key 管理 */
export class ApiKeyApi extends BaseApi {
  async list(): Promise<ApiResult<ApiKeyInfo[]>> {
    return this.post<ApiKeyInfo[]>("/web/apiKeys", { action: "list" });
  }
  async create(body: { name: string; expiresIn?: number }): Promise<ApiResult<{ key: string }>> {
    return this.post<{ key: string }>("/web/apiKeys", { action: "create", ...body });
  }
  async delete(id: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/apiKeys", { action: "delete", id });
  }
  async update(id: string, data: Record<string, unknown>): Promise<ApiResult<ApiKeyInfo>> {
    return this.post<ApiKeyInfo>("/web/apiKeys", { action: "update", id, data });
  }
}
```

- [ ] **Step 2: 实现 WorkflowEngineApi**

```typescript
// packages/sdk/src/modules/workflow-engine.ts
import { BaseApi } from "../base";
import type { ApiResult } from "../result";

/** Workflow 运行时操作（action-based） */
export class WorkflowEngineApi extends BaseApi {
  async run(workflowId: string, body?: Record<string, unknown>): Promise<ApiResult<{ runId: string }>> {
    return this.post("/web/workflow-engine", { action: "run", workflowId, ...body });
  }
  async dryRun(workflowId: string, body?: Record<string, unknown>): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "dryRun", workflowId, ...body });
  }
  async cancel(runId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/workflow-engine", { action: "cancel", runId });
  }
  async approve(
    runId: string,
    nodeId: string,
    token: string,
    data?: Record<string, unknown>,
  ): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/workflow-engine", { action: "approve", runId, nodeId, token, data });
  }
  async getRunStatus(runId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "getRunStatus", runId });
  }
  async getEvents(runId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "getEvents", runId });
  }
  async getOutput(runId: string, nodeId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "getOutput", runId, nodeId });
  }
  async getPendingApprovals(runId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "getPendingApprovals", runId });
  }
  async listRuns(workflowId?: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "listRuns", workflowId });
  }
  async recover(runId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "recover", runId });
  }
  async rerunFrom(runId: string, nodeId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "rerunFrom", runId, nodeId });
  }
}
```

- [ ] **Step 3: 实现 WorkflowDefApi**

```typescript
// packages/sdk/src/modules/workflow-defs.ts
import { BaseApi } from "../base";
import type { ApiResult } from "../result";

/** Workflow 定义管理（action-based） */
export class WorkflowDefApi extends BaseApi {
  async create(body: Record<string, unknown>): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "create", ...body });
  }
  async save(workflowId: string, yaml: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "save", workflowId, yaml });
  }
  async publish(workflowId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "publish", workflowId });
  }
  async list(): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "list" });
  }
  async get(workflowId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "get", workflowId });
  }
  async getVersions(workflowId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "getVersions", workflowId });
  }
  async getVersion(workflowId: string, version: number): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "getVersion", workflowId, version });
  }
  async setLatest(workflowId: string, version: number): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "setLatest", workflowId, version });
  }
  async delete(workflowId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "delete", workflowId });
  }
  async updateMeta(workflowId: string, data: Record<string, unknown>): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "updateMeta", workflowId, data });
  }
  async restoreToDraft(workflowId: string, version: number): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "restoreToDraft", workflowId, version });
  }
}
```

- [ ] **Step 4: 实现 MetaAgentApi + AuthApi**

```typescript
// packages/sdk/src/modules/meta-agent.ts
import { BaseApi } from "../base";
import type { ApiResult } from "../result";

export class MetaAgentApi extends BaseApi {
  /** POST /web/meta-agent/ensure — 确保 Meta Agent 环境存在 */
  async ensure(): Promise<ApiResult<{ id: string; name: string }>> {
    return this.post("/web/meta-agent/ensure");
  }
}
```

```typescript
// packages/sdk/src/modules/auth.ts
import { BaseApi } from "../base";
import type { ApiResult } from "../result";

export class AuthApi extends BaseApi {
  /** POST /web/bind — 绑定会话到用户 */
  async bind(body?: { sessionId?: string; uuid?: string }): Promise<ApiResult<{ ok: boolean; sessionId: string }>> {
    return this.post("/web/bind", body);
  }
}
```

- [ ] **Step 5: 实现 V1 模块**

```typescript
// packages/sdk/src/modules/v1-environment.ts
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type { BridgeRegistrationRequest, BridgeRegistrationResponse, StatusOkResponse } from "../types/schemas";

export class V1EnvironmentApi extends BaseApi {
  /** POST /v1/environments/bridge — REST 注册 */
  async registerBridge(
    body: BridgeRegistrationRequest,
  ): Promise<ApiResult<BridgeRegistrationResponse>> {
    return this.post("/v1/environments/bridge", body);
  }

  /** DELETE /v1/environments/bridge/:id — 注销 */
  async deregisterBridge(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.del("/v1/environments/bridge/:id", { params });
  }

  /** POST /v1/environments/:id/bridge/reconnect — 重连 */
  async reconnectBridge(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/environments/:id/bridge/reconnect", undefined, { params });
  }

  /** GET /v1/environments/:id/work/poll — 长轮询工作项 */
  async pollWork(params: { id: string }): Promise<ApiResult<unknown>> {
    return this.get("/v1/environments/:id/work/poll", { params });
  }

  /** POST /v1/environments/:id/work/:workId/ack — 确认工作 */
  async ackWork(params: { id: string; workId: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/environments/:id/work/:workId/ack", undefined, { params });
  }

  /** POST /v1/environments/:id/work/:workId/stop — 停止工作 */
  async stopWork(params: { id: string; workId: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/environments/:id/work/:workId/stop", undefined, { params });
  }

  /** POST /v1/environments/:id/work/:workId/heartbeat — 心跳 */
  async heartbeat(params: { id: string; workId: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/environments/:id/work/:workId/heartbeat", undefined, { params });
  }
}
```

```typescript
// packages/sdk/src/modules/v1-session.ts
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  CreateSessionRequest,
  V1CreateSessionResponse,
  V1GetSessionResponse,
  V1SendEventsResponse,
  UpdateSessionRequest,
  StatusOkResponse,
} from "../types/schemas";

export class V1SessionApi extends BaseApi {
  /** POST /v1/sessions — 创建会话 */
  async create(body: CreateSessionRequest): Promise<ApiResult<V1CreateSessionResponse>> {
    return this.post("/v1/sessions", body);
  }

  /** GET /v1/sessions/:id — 获取会话 */
  async get(params: { id: string }): Promise<ApiResult<V1GetSessionResponse>> {
    return this.get("/v1/sessions/:id", { params });
  }

  /** PATCH /v1/sessions/:id — 更新会话 */
  async update(
    params: { id: string },
    body: UpdateSessionRequest,
  ): Promise<ApiResult<V1GetSessionResponse>> {
    return this.patch("/v1/sessions/:id", body, { params });
  }

  /** POST /v1/sessions/:id/archive — 归档 */
  async archive(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/sessions/:id/archive", undefined, { params });
  }

  /** POST /v1/sessions/:id/events — 发送事件 */
  async sendEvents(
    params: { id: string },
    body: { events: Record<string, unknown>[] | Record<string, unknown> },
  ): Promise<ApiResult<V1SendEventsResponse>> {
    return this.post("/v1/sessions/:id/events", body, { params });
  }
}
```

- [ ] **Step 6: 实现 V2 模块**

```typescript
// packages/sdk/src/modules/v2-code-session.ts
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  CreateCodeSessionRequest,
  CreateCodeSessionResponse,
  CodeSessionBridgeResponse,
} from "../types/schemas";

export class V2CodeSessionApi extends BaseApi {
  /** POST /v1/code/sessions — 创建 code session */
  async create(body: CreateCodeSessionRequest): Promise<ApiResult<CreateCodeSessionResponse>> {
    return this.post("/v1/code/sessions", body);
  }

  /** POST /v1/code/sessions/:id/bridge — 获取连接信息 */
  async bridge(params: { id: string }): Promise<ApiResult<CodeSessionBridgeResponse>> {
    return this.post("/v1/code/sessions/:id/bridge", undefined, { params });
  }
}
```

```typescript
// packages/sdk/src/modules/v2-worker.ts
import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  GetWorkerResponse,
  UpdateWorkerResponse as V2UpdateWorkerResponse,
  WorkerHeartbeatResponse,
  UpdateWorkerRequest,
  WorkerEventsRequest,
  WorkerEventsResponse,
  WorkerStateRequest,
  StatusOkResponse,
} from "../types/schemas";

export class V2WorkerApi extends BaseApi {
  /** GET /v1/code/sessions/:id/worker — 读取 worker 状态 */
  async get(params: { id: string }): Promise<ApiResult<GetWorkerResponse>> {
    return this.get("/v1/code/sessions/:id/worker", { params });
  }

  /** PUT /v1/code/sessions/:id/worker — 更新 worker 状态 */
  async update(
    params: { id: string },
    body: UpdateWorkerRequest,
  ): Promise<ApiResult<V2UpdateWorkerResponse>> {
    return this.put("/v1/code/sessions/:id/worker", body, { params });
  }

  /** POST /v1/code/sessions/:id/worker/heartbeat — 心跳 */
  async heartbeat(params: { id: string }): Promise<ApiResult<WorkerHeartbeatResponse>> {
    return this.post("/v1/code/sessions/:id/worker/heartbeat", undefined, { params });
  }

  /** POST /v1/code/sessions/:id/worker/register — 注册 */
  async register(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/code/sessions/:id/worker/register", undefined, { params });
  }

  /** POST /v1/code/sessions/:id/worker/events — 写入事件 */
  async sendEvents(
    params: { id: string },
    body: WorkerEventsRequest,
  ): Promise<ApiResult<WorkerEventsResponse>> {
    return this.post("/v1/code/sessions/:id/worker/events", body, { params });
  }

  /** PUT /v1/code/sessions/:id/worker/state — 报告 worker 状态 */
  async updateState(
    params: { id: string },
    body: WorkerStateRequest,
  ): Promise<ApiResult<StatusOkResponse>> {
    return this.put("/v1/code/sessions/:id/worker/state", body, { params });
  }

  /** PUT /v1/code/sessions/:id/worker/external_metadata — 报告 metadata */
  async updateMetadata(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.put("/v1/code/sessions/:id/worker/external_metadata", undefined, { params });
  }

  /** POST /v1/code/sessions/:id/worker/events/delivery — 批量投递确认 */
  async deliveryBatch(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/code/sessions/:id/worker/events/delivery", undefined, { params });
  }

  /** POST /v1/code/sessions/:id/worker/events/:eventId/delivery — 单条投递确认 */
  async deliveryEvent(params: { id: string; eventId: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/code/sessions/:id/worker/events/:eventId/delivery", undefined, { params });
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/modules/
git commit -m "feat(sdk): 实现全部模块类（Organization/Workflow/V1/V2/Config/Auth/Meta）"
```

---

### Task 19: 统一导出 + index.ts 更新

**Files:**
- Create: `packages/sdk/src/modules/index.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: 创建 modules/index.ts 统一导出**

```typescript
// Web 模块
export { EnvironmentApi } from "./environment";
export { SessionApi, ControlApi } from "./session";
export { InstanceApi } from "./instance";
export { TaskApi } from "./task";
export { FileApi, UserFileApi } from "./file";
export { S3FileApi } from "./s3-file";
export { KnowledgeBaseApi } from "./knowledge";
export { ChannelApi } from "./channel";
export { ProviderApi, ModelApi, AgentApi, SkillConfigApi, McpApi } from "./config";
export { OrganizationApi, ApiKeyApi } from "./organization";
export { WorkflowEngineApi } from "./workflow-engine";
export { WorkflowDefApi } from "./workflow-defs";
export { MetaAgentApi } from "./meta-agent";
export { AuthApi } from "./auth";

// V1 模块
export { V1EnvironmentApi } from "./v1-environment";
export { V1SessionApi } from "./v1-session";

// V2 模块
export { V2CodeSessionApi } from "./v2-code-session";
export { V2WorkerApi } from "./v2-worker";
```

- [ ] **Step 2: 更新 packages/sdk/src/index.ts**

```typescript
// @mothership/sdk — 类型安全 REST API 客户端

// 基础类
export { BaseApi } from "./base";

// Result 类型
export type { ApiResult, ApiError, ApiOk, ApiErr } from "./result";
export { ok, err } from "./result";

// 从后端 schema 重导出的类型
export type * from "./types/schemas";

// 模块类
export * from "./modules";
```

- [ ] **Step 3: 运行 typecheck**

Run: `bunx tsc -p packages/sdk/tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/modules/index.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): 统一导出所有模块类和类型"
```

---

## Self-Review

**1. Spec coverage:**
- 所有 `/web/*` REST 端点有对应方法 ✓
- 所有 `/v1/*` REST 端点有对应方法 ✓
- 所有 `/v2/*` REST 端点有对应方法 ✓
- Config action-based 路由按 action 拆分为独立方法 ✓
- Workflow action-based 路由按 action 拆分为独立方法 ✓
- Organization action-based 路由按 action 拆分为独立方法 ✓
- FormData 上传方法 ✓
- params 对象 + 模板替换 ✓
- Result 模式返回值 ✓

**2. Placeholder scan:** 无 TBD/TODO。所有方法实现完整。

**3. Type consistency:**
- 所有方法返回 `Promise<ApiResult<T>>` ✓
- `BaseApi` 的 `get/post/put/patch/del/upload` 签名一致 ✓
- params 类型统一为 `{ key: string }` 对象 ✓
- Config 模块的 `data` 参数使用 `Record<string, unknown>` 保持灵活性 ✓
- Workflow/Organization 的未知响应类型使用 `unknown`，后续可精确化 ✓
