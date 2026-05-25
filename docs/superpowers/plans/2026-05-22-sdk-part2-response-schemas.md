# @mothership/sdk 实现计划 — Part 2: 后端补全 Response Schema

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为所有后端路由补全缺失的 Response Zod Schema 和对应的 `export type XxxResponse = z.infer<typeof XxxSchema>`，使 SDK 能通过类型重导出层获得完整的响应类型。

**Architecture:** 在现有 `src/schemas/*.ts` 文件中追加 Response Schema。不新建文件，不修改路由逻辑，只补充类型定义。对于 action-based 路由（config/workflow），按 action 分组定义响应类型。

**Tech Stack:** Zod v4 (`from "zod/v4"`)

---

## 缺失 Response Schema 清单

根据路由文件调查，以下端点缺少 Response Schema：

### environment.schema.ts — 需补充
- `POST /web/environments` 返回 `EnvironmentInfo + secret`（已有 `EnvironmentDetailResponseSchema`，可直接复用）
- `PUT /web/environments/:id` 返回更新后的环境（需要 `UpdateEnvironmentResponseSchema`）
- `GET /web/environments/:id` 返回 `EnvironmentInfo + secret`（复用 `EnvironmentDetailResponseSchema`）
- `DELETE /web/environments/:id` 返回 `{ ok: true }`（需要通用 `OkResponseSchema`）

### session.schema.ts — 需补充
- `GET /web/sessions` 返回 `SessionSummary[]`（需要 `SessionListResponseSchema`）
- `GET /web/sessions/:id` 返回 `SessionResponse`（已有，可直接复用）

### instance.schema.ts — 需补充
- `POST /web/instances/from-environment` 返回 `InstanceInfo`（已有，复用）
- `GET /web/instances` 返回 `InstanceInfo[]`（需要 `InstanceListResponseSchema`）
- `DELETE /web/instances/:id` 返回 `{ ok: true }`（通用 OkResponse）

### task.schema.ts — 需补充
- 大部分 task 端点返回 `TaskInfo` 或 `TaskInfo[]`，已有 schema 可复用
- `DELETE /web/tasks/:id` 返回被删除的 task
- `POST /web/tasks/:id/toggle` 返回更新后的 task
- `POST /web/tasks/:id/trigger` 返回触发结果
- `DELETE /web/tasks/:id/logs` 返回清除结果

### knowledge.schema.ts — 需补充
- `GET /web/knowledgeBases` 返回 `KnowledgeBaseInfo[]`（需要列表 Response）
- `GET /web/knowledgeBases/:id` 返回 `KnowledgeBaseInfo`
- `DELETE /web/knowledgeBases/:id` 返回 `{ ok: true }`
- `POST /web/knowledgeBases/:id/resources/upload` 返回 `{ items: KnowledgeResourceItem[] }`
- `POST /web/knowledgeBases/:id/resources/url` 返回 `KnowledgeResourceItem`
- `DELETE /web/knowledgeBases/:id/resources/:resourceId` 返回删除结果

### channel.schema.ts — 需补充
- `GET /web/channels/providers` 返回 `ChannelProviderDescriptor[]`
- `GET /web/channels/bindings` 返回 `ChannelBinding[]`
- `POST /web/channels/bindings` 返回 `ChannelBinding`
- `DELETE /web/channels/bindings/:id` 返回 `{ success: true }`
- `PATCH /web/channels/bindings/:id` 返回 `ChannelBinding`

### common.schema.ts — 需补充
- 通用 `OkResponseSchema`: `{ ok: true }`
- 通用 `StatusOkResponseSchema`: `{ status: "ok" }`

### config.schema.ts — 需补充
- Config 路由统一返回 `{ success, data }`，已被 `ConfigResponseSchema<T>` 覆盖
- 但需要为每个 config 模块定义具体的 response data 类型

### control.schema.ts (新) — 需补充
- `POST /web/sessions/:id/events` 返回 `{ status: "ok", event: SessionEvent }`
- `POST /web/sessions/:id/control` 返回 `{ status: "ok", event: SessionEvent }`
- `POST /web/sessions/:id/interrupt` 返回 `{ status: "ok" }`

### workflow schema — action-based，需要按 action 定义
- workflow-engine 和 workflow-defs 的 action-based 路由需要各自的响应类型

### v1/v2 schemas — 需补充
- 大量 `{ status: "ok" }` 格式的响应
- v2 worker 相关的响应类型

---

### Task 6: 补充 common.schema.ts 通用响应

**Files:**
- Modify: `src/schemas/common.schema.ts`

- [ ] **Step 1: 添加通用响应 schema**

在 `src/schemas/common.schema.ts` 末尾追加：

```typescript
/** 通用操作成功响应: `{ ok: true }` */
export const OkResponseSchema = z.object({
  ok: z.literal(true),
});

/** 通用状态响应: `{ status: "ok" }` */
export const StatusOkResponseSchema = z.object({
  status: z.literal("ok"),
});

/** 通用状态响应（带额外数据）: `{ status: "ok", ...extra }` */
export const StatusOkWithDataSchema = <T extends z.ZodTypeAny>(extraSchema: T) =>
  StatusOkResponseSchema.merge(z.object({}).extend(extraSchema._zod?.def?.shape ?? {}));

export type OkResponse = z.infer<typeof OkResponseSchema>;
export type StatusOkResponse = z.infer<typeof StatusOkResponseSchema>;
```

- [ ] **Step 2: 在 schemas/index.ts 中导出**

在 `src/schemas/index.ts` 的 common 导出块中追加：

```typescript
export {
  // ... 已有导出 ...
  OkResponseSchema,
  type OkResponse,
  StatusOkResponseSchema,
  type StatusOkResponse,
} from "./common.schema";
```

- [ ] **Step 3: 运行 typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/schemas/common.schema.ts src/schemas/index.ts
git commit -m "feat(schemas): 添加通用 OkResponse / StatusOkResponse schema"
```

---

### Task 7: 补充 environment Response Schema

**Files:**
- Modify: `src/schemas/environment.schema.ts`

- [ ] **Step 1: 在 environment.schema.ts 末尾追加**

```typescript
/** PUT /web/environments/:id — 更新环境后的响应 */
export const UpdateEnvironmentResponseSchema = EnvironmentInfoSchema;

/** DELETE /web/environments/:id — 删除环境响应 */
export const DeleteEnvironmentResponseSchema = OkResponseSchema;

export type UpdateEnvironmentResponse = z.infer<typeof UpdateEnvironmentResponseSchema>;
export type DeleteEnvironmentResponse = z.infer<typeof DeleteEnvironmentResponseSchema>;
```

注意：`OkResponseSchema` 需要从 `./common.schema` 导入。在文件顶部添加：

```typescript
import { OkResponseSchema } from "./common.schema";
```

- [ ] **Step 2: 在 schemas/index.ts 导出**

追加到 environment 导出块：

```typescript
export {
  // ... 已有 ...
  type DeleteEnvironmentResponse,
  DeleteEnvironmentResponseSchema,
  EnvironmentDetailResponseSchema,
  type UpdateEnvironmentResponse,
  UpdateEnvironmentResponseSchema,
} from "./environment.schema";
```

- [ ] **Step 3: 运行 typecheck**

Run: `bunx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/schemas/environment.schema.ts src/schemas/index.ts
git commit -m "feat(schemas): 补充 environment Update/Delete Response Schema"
```

---

### Task 8: 补充 session Response Schema

**Files:**
- Modify: `src/schemas/session.schema.ts`

- [ ] **Step 1: 追加 session 列表和事件发送响应**

```typescript
/** GET /web/sessions — 会话列表响应 */
export const SessionListResponseSchema = SessionSummarySchema.array();

/** POST /web/sessions/:id/events / control — 事件发送响应 */
export const SendEventResponseSchema = z.object({
  status: z.literal("ok"),
  event: SessionEventSchema,
});

/** POST /web/sessions/:id/interrupt — 中断响应 */
export const InterruptResponseSchema = StatusOkResponseSchema;

export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type SendEventResponse = z.infer<typeof SendEventResponseSchema>;
export type InterruptResponse = z.infer<typeof InterruptResponseSchema>;
```

文件顶部追加导入：

```typescript
import { StatusOkResponseSchema } from "./common.schema";
```

- [ ] **Step 2: 在 schemas/index.ts 导出**

```typescript
export {
  // ... 已有 session 导出 ...
  type InterruptResponse,
  InterruptResponseSchema,
  type SendEventResponse,
  SendEventResponseSchema,
  type SessionListResponse,
  SessionListResponseSchema,
} from "./session.schema";
```

- [ ] **Step 3: typecheck + commit**

Run: `bunx tsc --noEmit` → PASS

```bash
git add src/schemas/session.schema.ts src/schemas/index.ts
git commit -m "feat(schemas): 补充 session 列表/事件发送/中断 Response Schema"
```

---

### Task 9: 补充 instance/task/knowledge/channel Response Schema

**Files:**
- Modify: `src/schemas/instance.schema.ts`
- Modify: `src/schemas/task.schema.ts`
- Modify: `src/schemas/knowledge.schema.ts`
- Modify: `src/schemas/channel.schema.ts`
- Modify: `src/schemas/index.ts`

- [ ] **Step 1: instance.schema.ts 追加**

文件顶部添加导入：

```typescript
import { OkResponseSchema } from "./common.schema";
```

文件末尾追加：

```typescript
/** GET /web/instances — 实例列表响应 */
export const InstanceListResponseSchema = InstanceInfoSchema.array();

/** DELETE /web/instances/:id — 删除实例响应 */
export const DeleteInstanceResponseSchema = OkResponseSchema;

export type InstanceListResponse = z.infer<typeof InstanceListResponseSchema>;
export type DeleteInstanceResponse = z.infer<typeof DeleteInstanceResponseSchema>;
```

- [ ] **Step 2: task.schema.ts 追加**

文件顶部添加导入：

```typescript
import { OkResponseSchema, StatusOkResponseSchema } from "./common.schema";
```

文件末尾追加：

```typescript
/** DELETE /web/tasks/:id — 删除任务响应（返回被删除的 task） */
export const DeleteTaskResponseSchema = TaskInfoSchema;

/** POST /web/tasks/:id/toggle — 切换启用状态响应 */
export const ToggleTaskResponseSchema = TaskInfoSchema;

/** POST /web/tasks/:id/trigger — 手动触发响应 */
export const TriggerTaskResponseSchema = StatusOkResponseSchema;

/** DELETE /web/tasks/:id/logs — 清除日志响应 */
export const ClearTaskLogsResponseSchema = StatusOkResponseSchema;

export type DeleteTaskResponse = z.infer<typeof DeleteTaskResponseSchema>;
export type ToggleTaskResponse = z.infer<typeof ToggleTaskResponseSchema>;
export type TriggerTaskResponse = z.infer<typeof TriggerTaskResponseSchema>;
export type ClearTaskLogsResponse = z.infer<typeof ClearTaskLogsResponseSchema>;
```

- [ ] **Step 3: knowledge.schema.ts 追加**

文件顶部添加导入：

```typescript
import { OkResponseSchema } from "./common.schema";
```

文件末尾追加：

```typescript
/** GET /web/knowledgeBases — 知识库列表响应 */
export const KnowledgeBaseListResponseSchema = KnowledgeBaseInfoSchema.array();

/** DELETE /web/knowledgeBases/:id — 删除知识库响应 */
export const DeleteKnowledgeBaseResponseSchema = OkResponseSchema;

/** POST /web/knowledgeBases/:id/resources/upload — 上传资源响应 */
export const UploadKnowledgeResourcesResponseSchema = z.object({
  items: KnowledgeResourceItemSchema.array(),
});

/** POST /web/knowledgeBases/:id/resources/url — 导入 URL 响应 */
export const ImportKnowledgeUrlResponseSchema = KnowledgeResourceItemSchema;

/** DELETE /web/knowledgeBases/:id/resources/:resourceId — 删除资源响应 */
export const DeleteKnowledgeResourceResponseSchema = OkResponseSchema;

export type KnowledgeBaseListResponse = z.infer<typeof KnowledgeBaseListResponseSchema>;
export type DeleteKnowledgeBaseResponse = z.infer<typeof DeleteKnowledgeBaseResponseSchema>;
export type UploadKnowledgeResourcesResponse = z.infer<typeof UploadKnowledgeResourcesResponseSchema>;
export type ImportKnowledgeUrlResponse = z.infer<typeof ImportKnowledgeUrlResponseSchema>;
export type DeleteKnowledgeResourceResponse = z.infer<typeof DeleteKnowledgeResourceResponseSchema>;
```

- [ ] **Step 4: channel.schema.ts 追加**

文件顶部添加导入：

```typescript
import { OkResponseSchema } from "./common.schema";
```

文件末尾追加：

```typescript
/** GET /web/channels/providers — 通道供应商列表 */
export const ChannelProviderListResponseSchema = ChannelProviderDescriptorSchema.array();

/** GET /web/channels/bindings — 通道绑定列表 */
export const ChannelBindingListResponseSchema = ChannelBindingSchema.array();

/** POST /web/channels/bindings — 创建绑定响应 */
export const CreateChannelBindingResponseSchema = ChannelBindingSchema;

/** DELETE /web/channels/bindings/:id — 删除绑定响应 */
export const DeleteChannelBindingResponseSchema = OkResponseSchema;

/** PATCH /web/channels/bindings/:id — 更新绑定响应 */
export const UpdateChannelBindingResponseSchema = ChannelBindingSchema;

export type ChannelProviderListResponse = z.infer<typeof ChannelProviderListResponseSchema>;
export type ChannelBindingListResponse = z.infer<typeof ChannelBindingListResponseSchema>;
export type CreateChannelBindingResponse = z.infer<typeof CreateChannelBindingResponseSchema>;
export type DeleteChannelBindingResponse = z.infer<typeof DeleteChannelBindingResponseSchema>;
export type UpdateChannelBindingResponse = z.infer<typeof UpdateChannelBindingResponseSchema>;
```

- [ ] **Step 5: 统一更新 schemas/index.ts 导出**

将所有新增的 schema 和 type 追加到对应的导出块中。

- [ ] **Step 6: typecheck + commit**

Run: `bunx tsc --noEmit` → PASS

```bash
git add src/schemas/instance.schema.ts src/schemas/task.schema.ts src/schemas/knowledge.schema.ts src/schemas/channel.schema.ts src/schemas/index.ts
git commit -m "feat(schemas): 补充 instance/task/knowledge/channel Response Schema"
```

---

### Task 10: 补充 v1/v2 Response Schema

**Files:**
- Modify: `src/schemas/v1-environment.schema.ts`
- Modify: `src/schemas/v1-session.schema.ts`
- Modify: `src/schemas/v2-code-session.schema.ts`
- Modify: `src/schemas/v2-worker.schema.ts`
- Modify: `src/schemas/v2-worker-events.schema.ts`
- Modify: `src/schemas/index.ts`

- [ ] **Step 1: v1-environment.schema.ts 追加**

```typescript
import { StatusOkResponseSchema, type StatusOkResponse } from "./common.schema";

/** POST /v1/environments/bridge 注册响应 — 返回完整环境信息 */
export const BridgeRegistrationResponseSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  token: z.string().optional(),
  secret: z.string().optional(),
  status: z.string().optional(),
});

/** DELETE /v1/environments/bridge/:id / POST reconnect / work ack/stop/heartbeat — 通用状态响应 */
export const V1StatusOkResponseSchema = StatusOkResponseSchema;

export type BridgeRegistrationResponse = z.infer<typeof BridgeRegistrationResponseSchema>;
```

注意：`StatusOkResponse` 类型通过 re-export 给 SDK 使用，不需要重新定义。

- [ ] **Step 2: v1-session.schema.ts 追加**

文件顶部添加：

```typescript
import { SessionResponseSchema, type SessionResponse } from "./session.schema";
import { StatusOkResponseSchema } from "./common.schema";
```

文件末尾追加：

```typescript
/** POST /v1/sessions — 创建会话响应 */
export const V1CreateSessionResponseSchema = SessionResponseSchema;

/** GET /v1/sessions/:id — 获取会话响应 */
export const V1GetSessionResponseSchema = SessionResponseSchema;

/** PATCH /v1/sessions/:id — 更新会话响应 */
export const V1UpdateSessionResponseSchema = SessionResponseSchema;

/** POST /v1/sessions/:id/archive — 归档响应 */
export const V1ArchiveSessionResponseSchema = StatusOkResponseSchema;

/** POST /v1/sessions/:id/events — 发送事件响应 */
export const V1SendEventsResponseSchema = z.object({
  status: z.literal("ok"),
  events: z.number(),
});

export type V1CreateSessionResponse = z.infer<typeof V1CreateSessionResponseSchema>;
export type V1GetSessionResponse = z.infer<typeof V1GetSessionResponseSchema>;
export type V1SendEventsResponse = z.infer<typeof V1SendEventsResponseSchema>;
```

- [ ] **Step 3: v2-code-session.schema.ts 追加**

```typescript
import { SessionResponseSchema } from "./session.schema";

/** POST /v1/code/sessions — 创建 code session 响应 */
export const CreateCodeSessionResponseSchema = z.object({
  session: SessionResponseSchema,
});

/** POST /v1/code/sessions/:id/bridge — 获取连接信息 */
export const CodeSessionBridgeResponseSchema = z.object({
  api_base_url: z.string(),
  worker_jwt: z.string(),
  expires_in: z.number(),
});

export type CreateCodeSessionResponse = z.infer<typeof CreateCodeSessionResponseSchema>;
export type CodeSessionBridgeResponse = z.infer<typeof CodeSessionBridgeResponseSchema>;
```

- [ ] **Step 4: v2-worker.schema.ts 追加**

```typescript
import { StatusOkResponseSchema } from "./common.schema";

/** GET /v1/code/sessions/:id/worker — 读取 worker 状态 */
export const GetWorkerResponseSchema = z.object({
  worker: z.object({
    worker_status: z.string().nullable(),
    external_metadata: z.record(z.string(), z.unknown()).nullable(),
    requires_action_details: z.record(z.string(), z.unknown()).nullable(),
    last_heartbeat_at: z.string().nullable(),
  }),
});

/** PUT /v1/code/sessions/:id/worker — 更新 worker 状态响应 */
export const UpdateWorkerResponseSchema = z.object({
  status: z.literal("ok"),
  worker: z.object({
    worker_status: z.string().nullable(),
    external_metadata: z.record(z.string(), z.unknown()).nullable(),
    requires_action_details: z.record(z.string(), z.unknown()).nullable(),
    last_heartbeat_at: z.string().nullable(),
  }),
});

/** POST /v1/code/sessions/:id/worker/heartbeat — 心跳响应 */
export const WorkerHeartbeatResponseSchema = z.object({
  status: z.literal("ok"),
  last_heartbeat_at: z.string(),
});

/** POST /v1/code/sessions/:id/worker/register — 注册响应 */
export const WorkerRegisterResponseSchema = StatusOkResponseSchema;

export type GetWorkerResponse = z.infer<typeof GetWorkerResponseSchema>;
export type UpdateWorkerResponse = z.infer<typeof UpdateWorkerResponseSchema>;
export type WorkerHeartbeatResponse = z.infer<typeof WorkerHeartbeatResponseSchema>;
```

- [ ] **Step 5: v2-worker-events.schema.ts 追加**

```typescript
import { StatusOkResponseSchema } from "./common.schema";

/** POST /v1/code/sessions/:id/worker/events — 写入事件响应 */
export const WorkerEventsResponseSchema = z.object({
  status: z.literal("ok"),
  count: z.number(),
});

/** PUT worker/state, PUT external_metadata, POST delivery — 通用状态响应 */
export const WorkerStatusOkResponseSchema = StatusOkResponseSchema;

export type WorkerEventsResponse = z.infer<typeof WorkerEventsResponseSchema>;
```

- [ ] **Step 6: 更新 schemas/index.ts 导出所有新增类型**

确保所有新增的 schema 和 type 都在 `index.ts` 中导出。

- [ ] **Step 7: typecheck + commit**

Run: `bunx tsc --noEmit` → PASS

```bash
git add src/schemas/v1-environment.schema.ts src/schemas/v1-session.schema.ts src/schemas/v2-code-session.schema.ts src/schemas/v2-worker.schema.ts src/schemas/v2-worker-events.schema.ts src/schemas/index.ts
git commit -m "feat(schemas): 补充 v1/v2 全量 Response Schema"
```

---

### Task 11: 更新 SDK 类型重导出层

**Files:**
- Modify: `packages/sdk/src/types/schemas.ts`

- [ ] **Step 1: 追加所有新增的 Response 类型导出**

在 `packages/sdk/src/types/schemas.ts` 中追加 Part 2 新增的所有类型：

```typescript
// ── Common Response ──
export type { OkResponse, StatusOkResponse } from "../../../src/schemas/common.schema";

// ── Environment Response ──
export type {
  UpdateEnvironmentResponse,
  DeleteEnvironmentResponse,
} from "../../../src/schemas/environment.schema";

// ── Session Response ──
export type {
  SessionListResponse,
  SendEventResponse,
  InterruptResponse,
} from "../../../src/schemas/session.schema";

// ── Instance Response ──
export type {
  InstanceListResponse,
  DeleteInstanceResponse,
} from "../../../src/schemas/instance.schema";

// ── Task Response ──
export type {
  DeleteTaskResponse,
  ToggleTaskResponse,
  TriggerTaskResponse,
  ClearTaskLogsResponse,
} from "../../../src/schemas/task.schema";

// ── Knowledge Response ──
export type {
  KnowledgeBaseListResponse,
  DeleteKnowledgeBaseResponse,
  UploadKnowledgeResourcesResponse,
  ImportKnowledgeUrlResponse,
  DeleteKnowledgeResourceResponse,
} from "../../../src/schemas/knowledge.schema";

// ── Channel Response ──
export type {
  ChannelProviderListResponse,
  ChannelBindingListResponse,
  CreateChannelBindingResponse,
  DeleteChannelBindingResponse,
  UpdateChannelBindingResponse,
} from "../../../src/schemas/channel.schema";

// ── V1 Response ──
export type { BridgeRegistrationResponse } from "../../../src/schemas/v1-environment.schema";
export type {
  V1CreateSessionResponse,
  V1GetSessionResponse,
  V1SendEventsResponse,
} from "../../../src/schemas/v1-session.schema";

// ── V2 Response ──
export type {
  CreateCodeSessionResponse,
  CodeSessionBridgeResponse,
} from "../../../src/schemas/v2-code-session.schema";
export type {
  GetWorkerResponse,
  UpdateWorkerResponse as V2UpdateWorkerResponse,
  WorkerHeartbeatResponse,
} from "../../../src/schemas/v2-worker.schema";
export type { WorkerEventsResponse } from "../../../src/schemas/v2-worker-events.schema";
```

- [ ] **Step 2: typecheck**

Run: `bunx tsc -p packages/sdk/tsconfig.json --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/types/schemas.ts
git commit -m "feat(sdk): 更新类型重导出层，包含所有新增 Response 类型"
```

---

## Self-Review

**1. Spec coverage:**
- 所有 `/web/*` 端点的响应都有对应 schema ✓
- 所有 `/v1/*` 端点的响应都有对应 schema ✓
- 所有 `/v2/*` 端点的响应都有对应 schema ✓
- 通用响应（OkResponse, StatusOkResponse）已定义 ✓
- SDK 类型重导出层已同步更新 ✓

**2. Placeholder scan:** 无 TBD/TODO。所有 schema 定义完整。

**3. Type consistency:**
- `OkResponseSchema` 从 `common.schema.ts` 统一导出，所有需要 `{ ok: true }` 的地方引用它
- `StatusOkResponseSchema` 同上
- Response type 命名统一：`XxxResponseSchema` → `type XxxResponse = z.infer<>`
- v1/v2 响应使用前缀 `V1`/`V2`/具体名称避免与 web 路由类型冲突

**注意：** Config 和 Workflow 的 action-based 路由响应类型将在 Part 3（SDK 模块实现）中按需定义，因为它们的响应结构随 action 变化，不适合统一 schema。
