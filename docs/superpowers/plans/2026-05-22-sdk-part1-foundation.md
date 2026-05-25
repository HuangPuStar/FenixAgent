# @mothership/sdk 实现计划 — Part 1: SDK 基础设施

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建 `@mothership/sdk` workspace 包，包含 Result 类型、BaseApi 基类（fetch + params 模板替换 + 响应解包 + 错误处理），以及类型导入基础设施。

**Architecture:** SDK 作为独立 workspace package 存放在 `packages/sdk/`，通过 `tsconfig.base.json` 的 path alias `@mothership/sdk` 被前端引用。BaseApi 提供统一的 HTTP 方法（get/post/put/patch/del）和 params 模板替换，所有模块类继承 BaseApi。类型从后端 `src/schemas/` 的 `z.infer<>` 导出导入。

**Tech Stack:** TypeScript, Zod v4 (仅类型推导), Fetch API

---

## File Structure

```
packages/sdk/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts              # 统一导出
    ├── result.ts             # Result<T, E> 类型 + 辅助函数
    ├── base.ts               # BaseApi 基类
    └── types/
        └── schemas.ts        # 从后端 schemas 重导出类型
```

修改:
- `tsconfig.base.json` — 添加 `@mothership/sdk` path alias
- `web/vite.config.ts` — 添加 `@mothership/sdk` resolve alias

---

### Task 1: 创建 SDK 包结构

**Files:**
- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "@mothership/sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM"],
    "types": ["bun"],
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

注意：`lib` 包含 `"DOM"` 因为 BaseApi 使用 `fetch`、`FormData`、`Response` 等 DOM API。

- [ ] **Step 3: 创建 src/index.ts 占位**

```typescript
// @mothership/sdk — 类型安全 REST API 客户端
export { BaseApi } from "./base";
export type { ApiResult, ApiError, ok, err } from "./result";
```

- [ ] **Step 4: 验证包能被 TypeScript 识别**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc -p packages/sdk/tsconfig.json --noEmit 2>&1 | head -5`
Expected: 可能有 import 错误（因为 base.ts 和 result.ts 还不存在），但 tsconfig 能正常加载

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/
git commit -m "feat(sdk): 创建 @mothership/sdk 包结构"
```

---

### Task 2: 实现 Result 类型

**Files:**
- Create: `packages/sdk/src/result.ts`
- Test: `packages/sdk/src/__tests__/result.test.ts`

- [ ] **Step 1: 写 Result 类型的测试**

```typescript
import { describe, expect, it } from "bun:test";
import { err, ok } from "../result";

// ok() 返回成功结果
describe("Result type", () => {
  it("ok() 返回成功结果", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe(42);
    }
  });

  it("err() 返回错误结果", () => {
    const result = err("SOMETHING_WRONG", "出错了");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SOMETHING_WRONG");
      expect(result.error.message).toBe("出错了");
    }
  });

  it("ok() 支持 undefined data", () => {
    const result = ok(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeUndefined();
    }
  });

  it("TS 能正确收窄类型", () => {
    const result = ok("hello");
    if (result.ok) {
      // 这里 result.data 必须是 string
      const _str: string = result.data;
      expect(_str).toBe("hello");
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/sdk/src/__tests__/result.test.ts`
Expected: FAIL — `Cannot find module "../result"`

- [ ] **Step 3: 实现 Result 类型**

```typescript
/** API 错误信息 */
export interface ApiError {
  /** 错误码，如 "NOT_FOUND"、"VALIDATION_ERROR" */
  code: string;
  /** 人类可读的错误消息 */
  message: string;
  /** HTTP 状态码 */
  status?: number;
}

/** API 成功响应 */
export interface ApiOk<T> {
  readonly ok: true;
  readonly data: T;
}

/** API 失败响应 */
export interface ApiErr {
  readonly ok: false;
  readonly error: ApiError;
}

/** API 调用结果 — 联合类型，支持 TS 类型收窄 */
export type ApiResult<T> = ApiOk<T> | ApiErr;

/** 构造成功结果 */
export function ok<T>(data: T): ApiOk<T> {
  return { ok: true, data };
}

/** 构造失败结果 */
export function err(code: string, message: string, status?: number): ApiErr {
  return { ok: false, error: { code, message, status } };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/sdk/src/__tests__/result.test.ts`
Expected: all tests PASS

- [ ] **Step 5: 更新 index.ts 导出 Result**

在 `packages/sdk/src/index.ts` 中确认已有导出：

```typescript
export { BaseApi } from "./base";
export type { ApiResult, ApiError, ApiOk, ApiErr } from "./result";
export { ok, err } from "./result";
```

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/result.ts packages/sdk/src/__tests__/result.test.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): 实现 Result<T> 类型和 ok/err 构造函数"
```

---

### Task 3: 实现 BaseApi 基类

**Files:**
- Create: `packages/sdk/src/base.ts`
- Test: `packages/sdk/src/__tests__/base.test.ts`

- [ ] **Step 1: 写 BaseApi 的测试**

```typescript
import { describe, expect, it, mock, afterEach } from "bun:test";
import { BaseApi } from "../base";

// mock fetch
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// 测试 params 模板替换
describe("BaseApi.replaceParams", () => {
  it("替换单个参数", () => {
    const api = new BaseApi();
    const result = api["replaceParams"]("/web/sessions/:sessionId/events", {
      sessionId: "ses_123",
    });
    expect(result).toBe("/web/sessions/ses_123/events");
  });

  it("替换多个参数", () => {
    const api = new BaseApi();
    const result = api["replaceParams"]("/v1/:orgId/:userId/profile", {
      orgId: "org_1",
      userId: "usr_2",
    });
    expect(result).toBe("/v1/org_1/usr_2/profile");
  });

  it("无参数路径原样返回", () => {
    const api = new BaseApi();
    const result = api["replaceParams"]("/web/environments", {});
    expect(result).toBe("/web/environments");
  });
});

// 测试 GET 请求成功解包
describe("BaseApi.get — 成功响应", () => {
  it("解包 { success: true, data } 格式", async () => {
    const api = new BaseApi();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, data: { id: "1", name: "test" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await api["get"]<{ id: string; name: string }>("/web/environments");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("1");
      expect(result.data.name).toBe("test");
    }
  });

  it("非标准格式直接返回", async () => {
    const api = new BaseApi();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "ok", version: "1.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await api["get"]<{ status: string; version: string }>("/health");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.version).toBe("1.0");
    }
  });
});

// 测试 POST 请求错误处理
describe("BaseApi.post — 错误响应", () => {
  it("解包 { success: false, error } 格式", async () => {
    const api = new BaseApi();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "资源不存在" } }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;

    const result = await api["post"]("/web/environments", { name: "test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toBe("资源不存在");
    }
  });

  it("HTTP 错误无 JSON body 时返回 statusText", async () => {
    const api = new BaseApi();
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    ) as unknown as typeof fetch;

    const result = await api["post"]<never>("/web/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(500);
    }
  });
});

// 测试 FormData 上传
describe("BaseApi.upload", () => {
  it("发送 FormData 并解包响应", async () => {
    const api = new BaseApi();
    globalThis.fetch = mock(((_input: RequestInfo | URL, init?: RequestInit) => {
      // 验证 body 是 FormData 实例
      expect(init?.body).toBeInstanceOf(FormData);
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: { files: [{ name: "a.txt" }] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch);

    const fd = new FormData();
    fd.append("file", new Blob(["hello"]), "a.txt");
    const result = await api["upload"]<{ files: Array<{ name: string }> }>(
      "/web/environments/env_1/user/",
      fd,
    );
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/sdk/src/__tests__/base.test.ts`
Expected: FAIL — `Cannot find module "../base"`

- [ ] **Step 3: 实现 BaseApi 基类**

```typescript
import { type ApiError, type ApiResult, err, ok } from "./result";

type Params = Record<string, string | number>;
type QueryParams = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  params?: Params;
  query?: QueryParams;
}

/**
 * REST API 基类。提供统一的 HTTP 方法 + params 模板替换 + 响应解包。
 * 所有模块 API 类继承此类。
 */
export class BaseApi {
  /**
   * 替换路径中的 `:paramName` 占位符。
   * 例: `/web/sessions/:sessionId/events` + `{ sessionId: "123" }` → `/web/sessions/123/events`
   */
  protected replaceParams(path: string, params?: Params): string {
    if (!params) return path;
    let result = path;
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(`:${key}`, String(value));
    }
    return result;
  }

  /**
   * 构造查询字符串。
   * 例: `{ page: 1, pageSize: 20, active: true, name: undefined }` → `?page=1&pageSize=20&active=true`
   */
  protected buildQuery(query?: QueryParams): string {
    if (!query) return "";
    const entries = Object.entries(query).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return "";
    const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
    return `?${qs}`;
  }

  /**
   * 统一响应处理：解包 `{ success, data }` / `{ success, error }` 格式，或直接返回非标准格式。
   */
  protected async handleResponse<T>(response: Response): Promise<ApiResult<T>> {
    if (!response.ok && response.status >= 500) {
      const text = await response.text().catch(() => response.statusText);
      return err("SERVER_ERROR", text || response.statusText, response.status);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return err("INVALID_RESPONSE", `无法解析响应: ${response.status}`, response.status);
    }

    // 标准格式 { success: true, data: T }
    if (json && typeof json === "object" && "success" in json) {
      if (json.success === true && "data" in json) {
        return ok((json as { data: T }).data);
      }
      if (json.success === false && "error" in json) {
        const errorObj = (json as { error: { code?: string; message?: string; type?: string } }).error;
        return err(
          errorObj.code ?? errorObj.type ?? "UNKNOWN_ERROR",
          errorObj.message ?? "Unknown error",
          response.status,
        );
      }
    }

    // Elysia error() 格式 { error: { type, message } }
    if (json && typeof json === "object" && "error" in json && !("success" in json)) {
      const errorObj = (json as { error: { type?: string; message?: string } }).error;
      if (typeof errorObj === "object" && errorObj !== null) {
        return err(errorObj.type ?? "UNKNOWN_ERROR", errorObj.message ?? "Unknown error", response.status);
      }
    }

    // 非标准格式直接返回
    return ok(json as T);
  }

  /** GET 请求 */
  protected async get<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }

  /** POST 请求 */
  protected async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }

  /** PUT 请求 */
  protected async put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }

  /** PATCH 请求 */
  protected async patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }

  /** DELETE 请求 */
  protected async del<T>(path: string, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "DELETE",
        credentials: "include",
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }

  /** FormData 上传 */
  protected async upload<T>(path: string, formData: FormData, options?: RequestOptions): Promise<ApiResult<T>> {
    try {
      const url = this.replaceParams(path, options?.params) + this.buildQuery(options?.query);
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      return this.handleResponse<T>(response);
    } catch (e) {
      return err("NETWORK_ERROR", e instanceof Error ? e.message : "Network request failed");
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/sdk/src/__tests__/base.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/base.ts packages/sdk/src/__tests__/base.test.ts
git commit -m "feat(sdk): 实现 BaseApi 基类 — fetch/params/响应解包/错误处理"
```

---

### Task 4: 创建类型重导出层

**Files:**
- Create: `packages/sdk/src/types/schemas.ts`
- Modify: `packages/sdk/src/index.ts`

这一步将后端 `src/schemas/` 的 `z.infer<>` 类型重导出到 SDK 中，前端通过 `import type { XxxResponse } from "@mothership/sdk"` 使用。

- [ ] **Step 1: 创建类型重导出文件**

```typescript
/**
 * 从后端 Zod schema 重导出纯类型。
 * SDK 模块类使用这些类型作为方法参数和返回值。
 *
 * 注意：此处仅导出 type（通过 `export type`），不引入 Zod runtime。
 */

// ── Environment ──
export type {
  EnvironmentInfo,
  EnvironmentListResponse,
  CreateEnvironmentRequest,
  UpdateEnvironmentRequest,
  EnterEnvironmentResponse,
  ListInstancesResponse,
} from "../../../src/schemas/environment.schema";

// ── Instance ──
export type { InstanceInfo, InstanceStatus, SpawnInstanceFromEnvironmentRequest } from "../../../src/schemas/instance.schema";

// ── Session ──
export type { SessionResponse, SessionSummary, SessionEvent, SessionHistory } from "../../../src/schemas/session.schema";

// ── Config ──
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
} from "../../../src/schemas/config.schema";

// ── Task ──
export type { TaskInfo, ExecutionLogInfo, PaginatedLogs, CreateTaskRequest, UpdateTaskRequest } from "../../../src/schemas/task.schema";

// ── File ──
export type {
  FileEntry,
  FileListResponse,
  FileContent,
  FileUploadResponse,
  FileWriteResult,
} from "../../../src/schemas/file.schema";

// ── S3 File ──
export type {
  S3PresignGetQuery,
  S3PresignGetResponse,
  S3PresignPutBody,
  S3PresignPutResponse,
  S3FileListQuery,
  S3FileEntry,
  S3FileListResponse,
  S3UploadResponse,
} from "../../../src/schemas/s3-file.schema";

// ── Knowledge ──
export type {
  KnowledgeBaseInfo,
  KnowledgeResourceItem,
  CreateKnowledgeBaseRequest,
  UpdateKnowledgeBaseRequest,
} from "../../../src/schemas/knowledge.schema";

// ── Channel ──
export type {
  ChannelProviderDescriptor,
  HermesStatus,
  ChannelBinding,
  CreateChannelBindingRequest,
} from "../../../src/schemas/channel.schema";

// ── V1 ──
export type { BridgeRegistrationRequest } from "../../../src/schemas/v1-environment.schema";
export type {
  CreateSessionRequest,
  UpdateSessionRequest,
  SendEventsRequest,
} from "../../../src/schemas/v1-session.schema";

// ── V2 ──
export type { CreateCodeSessionRequest } from "../../../src/schemas/v2-code-session.schema";
export type { UpdateWorkerRequest } from "../../../src/schemas/v2-worker.schema";
export type { WorkerEventsRequest, WorkerStateRequest } from "../../../src/schemas/v2-worker-events.schema";
```

- [ ] **Step 2: 更新 index.ts 统一导出类型**

```typescript
// @mothership/sdk — 类型安全 REST API 客户端

// 基础类
export { BaseApi } from "./base";

// Result 类型
export type { ApiResult, ApiError, ApiOk, ApiErr } from "./result";
export { ok, err } from "./result";

// 从后端 schema 重导出的类型
export type * from "./types/schemas";
```

- [ ] **Step 3: 注册 tsconfig.base.json path alias**

在 `tsconfig.base.json` 的 `paths` 中添加：

```json
"@mothership/sdk": ["./packages/sdk/src/index.ts"]
```

完整的 `paths` 部分：

```json
"paths": {
  "@mothership/plugin-sdk": ["./packages/plugin-sdk/src/index.ts"],
  "@mothership/core": ["./packages/core/src/index.ts"],
  "@mothership/opencode": ["./packages/plugin-opencode/src/index.ts"],
  "@mothership/workflow-engine": ["./packages/workflow-engine/src/index.ts"],
  "@mothership/sdk": ["./packages/sdk/src/index.ts"]
}
```

- [ ] **Step 4: 在 web/vite.config.ts 添加 resolve alias**

在 `web/vite.config.ts` 的 `resolve.alias` 中添加：

```typescript
"@mothership/sdk": path.resolve(__dirname, "../packages/sdk/src/index.ts"),
```

- [ ] **Step 5: 运行 typecheck 验证类型导入链**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc -p packages/sdk/tsconfig.json --noEmit`
Expected: PASS（无错误）

- [ ] **Step 6: 在前端测试导入**

在任意前端 TS 文件（如测试文件）中临时添加：

```typescript
import type { EnvironmentListResponse, TaskInfo } from "@mothership/sdk";
const _env: EnvironmentListResponse = {} as EnvironmentListResponse;
const _task: TaskInfo = {} as TaskInfo;
```

运行: `bunx tsc --noEmit web/src/__tests__/eden-fetch-type-test.ts`（或任意前端文件）
Expected: 如果 `@mothership/sdk` alias 配置正确，类型能正常解析

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/types/schemas.ts packages/sdk/src/index.ts tsconfig.base.json web/vite.config.ts
git commit -m "feat(sdk): 创建类型重导出层，注册 @mothership/sdk alias"
```

---

### Task 5: 验证完整基础设施

**Files:**
- Create: `packages/sdk/src/__tests__/integration.test.ts`

- [ ] **Step 1: 写集成验证测试**

```typescript
import { describe, expect, it } from "bun:test";
import type { EnvironmentListResponse, TaskInfo, SessionResponse } from "../types/schemas";
import type { ApiResult } from "../result";
import { err, ok } from "../result";

// 验证类型导入链路
describe("SDK 基础设施集成", () => {
  it("能导入后端 schema 类型", () => {
    const env: EnvironmentListResponse = {
      id: "env_1",
      name: "test",
      description: null,
      workspace_path: "/tmp",
      agent_config_id: null,
      status: "active",
      machine_name: null,
      branch: null,
      auto_start: false,
      last_poll_at: null,
      created_at: 1000,
      updated_at: 1000,
      session_id: "ses_1",
      instance_status: null,
      instance_id: null,
      instances: [],
      instances_count: 0,
    };
    expect(env.id).toBe("env_1");
  });

  it("Result 类型与业务类型配合使用", () => {
    const result: ApiResult<TaskInfo> = ok({
      id: "task_1",
      name: "test",
      description: null,
      cron: "* * * * *",
      timezone: null,
      enabled: true,
      url: "http://example.com",
      method: "GET",
      headers: null,
      body: null,
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: null,
      createdAt: 1000,
      updatedAt: 1000,
    });
    expect(result.ok).toBe(true);
  });

  it("Result 错误类型", () => {
    const result: ApiResult<SessionResponse> = err("NOT_FOUND", "会话不存在", 404);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(404);
    }
  });
});
```

- [ ] **Step 2: 运行全部 SDK 测试**

Run: `bun test packages/sdk/`
Expected: all tests PASS

- [ ] **Step 3: 运行项目 precheck 确认无副作用**

Run: `bun run precheck`
Expected: PASS（SDK 包不影响现有代码）

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/__tests__/integration.test.ts
git commit -m "test(sdk): 添加基础设施集成验证测试"
```

---

## Self-Review

**1. Spec coverage:**
- Result 类型（ok/err + 联合类型收窄）✓
- BaseApi 基类（get/post/put/patch/del/upload）✓
- params 模板替换 ✓
- query 参数构造 ✓
- 响应解包（{ success, data } 格式 + Elysia error 格式 + 非标准格式）✓
- 错误处理（HTTP 错误 + JSON 解析失败 + 网络错误）✓
- 类型重导出层 ✓
- workspace 包注册 ✓

**2. Placeholder scan:** 无 TBD/TODO/placeholder。所有代码完整。

**3. Type consistency:**
- `ApiResult<T>` = `ApiOk<T> | ApiErr`，在 result.ts 和 base.ts 中一致使用
- `ApiError` 接口（code + message + status?）在 result.ts 定义，base.ts 通过 `err()` 构造
- `replaceParams` 签名 `(path: string, params?: Params)` 在 base.ts 定义，所有 HTTP 方法统一调用
