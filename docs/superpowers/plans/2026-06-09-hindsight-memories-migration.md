# Hindsight Memories 前端迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Hindsight 的 Memory + Documents + Mental Models 前端视图迁移到 RCS，通过 RCS 后端 API Proxy 转发请求到 Hindsight FastAPI 服务。

**Architecture:** RCS 后端扩展 `/web/hindsight/*` 路由作为 proxy 层，转发到 `HINDSIGHT_MCP_URL`。前端新建 `web/src/pages/hindsight/` 页面组件（从 Hindsight 复制改造），通过 `web/src/api/hindsight.ts` 客户端调用 RCS proxy 端点。Bank ID 使用 member ID（后端自动解析，前端不传）。

**Tech Stack:** Elysia proxy、React 19、TanStack Router、shadcn/ui、react-i18next、sonner toast

**Design doc:** `docs/superpowers/specs/2026-06-09-hindsight-memories-migration-design.md`

---

## File Structure

### 后端（修改）

| 文件 | 职责 |
|------|------|
| `src/services/hindsight.ts` | 现有：bank 管理。新增：`resolveMemberId` 导出、`proxyToHindsight` 通用转发 |
| `src/routes/web/hindsight.ts` | 现有：`/status`。新增：memories/documents/mental-models/recall/reflect proxy 端点 |

### 前端（新增）

| 文件 | 职责 |
|------|------|
| `web/src/api/hindsight.ts` | API 客户端，封装所有 `/web/hindsight/*` fetch 调用 |
| `web/src/routes/agent/_panel/memories.tsx` | TanStack Router 路由页面 |
| `web/src/pages/hindsight/MemoriesPage.tsx` | 主页面（Tab 切换：Memories / Documents / Mental Models） |
| `web/src/pages/hindsight/components/DataView.tsx` | 内存数据视图 |
| `web/src/pages/hindsight/components/DocumentsView.tsx` | 文档管理视图 |
| `web/src/pages/hindsight/components/MentalModelsView.tsx` | 心理模型视图 |
| `web/src/pages/hindsight/components/MemoryDetailPanel.tsx` | 内存详情侧面板 |
| `web/src/pages/hindsight/components/MemoryDetailModal.tsx` | 内存详情弹窗 |
| `web/src/pages/hindsight/components/MentalModelDetailModal.tsx` | 心理模型详情弹窗 |
| `web/src/pages/hindsight/components/CompactMarkdown.tsx` | Markdown 渲染 |
| `web/src/pages/hindsight/components/RecallPanel.tsx` | Recall 搜索面板 |
| `web/src/pages/hindsight/components/RetainDialog.tsx` | Retain 创建内存对话框 |
| `web/src/pages/hindsight/types.ts` | 共享 TypeScript 类型定义 |
| `web/src/i18n/locales/en/hindsight.json` | 英文翻译 |
| `web/src/i18n/locales/zh/hindsight.json` | 中文翻译 |

### 前端（修改）

| 文件 | 变更 |
|------|------|
| `web/src/pages/agent-panel/AgentSidebarConfig.tsx` | 添加 Memories 导航项 |
| `web/src/i18n/index.ts` | 注册 `hindsight` 命名空间 |
| `web/src/i18n/locales/en/agentPanel.json` | 添加 `memories` 键 |
| `web/src/i18n/locales/zh/agentPanel.json` | 添加 `memories` 键 |

---

## Task 1: 后端 — 导出 resolveMemberId + 新增 proxyToHindsight

**Files:**
- Modify: `src/services/hindsight.ts`

- [ ] **Step 1: 导出 resolveMemberId 并新增 proxyToHindsight 函数**

在 `src/services/hindsight.ts` 中：
1. 将 `resolveMemberId` 函数从 `private` 改为 `export`
2. 新增 `proxyToHindsight` 通用转发函数

```typescript
// src/services/hindsight.ts — 在现有代码基础上新增

/**
 * 通用 Hindsight API 转发。构造目标 URL 并转发请求。
 * 调用方负责传入正确的 bankId 路径段。
 */
export async function proxyToHindsight(
  path: string,
  options?: RequestInit
): Promise<Response> {
  const config = getHindsightConfig();
  if (!config) {
    throw new Error("HINDSIGHT_MCP_URL not configured");
  }
  return fetch(`${config.url}${path}`, options);
}
```

同时将 `resolveMemberId` 改为 `export`。

- [ ] **Step 2: 运行现有测试确认无回归**

Run: `bun test src/__tests__/hindsight-service.test.ts src/__tests__/hindsight-routes.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/hindsight.ts
git commit -m "feat(hindsight): 导出 resolveMemberId + 新增 proxyToHindsight 通用转发函数"
```

---

## Task 2: 后端 — 扩展 Proxy 路由端点

**Files:**
- Modify: `src/routes/web/hindsight.ts`

- [ ] **Step 1: 扩展路由，新增 memories/documents/mental-models/recall/reflect proxy 端点**

将 `src/routes/web/hindsight.ts` 扩展为完整的 proxy 路由。关键设计：
- 所有端点需要 auth + orgScope，后端从 auth context 解析 bankId（member ID）
- bankId 不由前端传入，后端自动解析
- 请求体透传到 Hindsight API，响应透传回前端

```typescript
// src/routes/web/hindsight.ts — 完整替换

import Elysia from "elysia";
import {
  getHindsightConfig,
  proxyToHindsight,
  resolveMemberId,
} from "../../services/hindsight";
import { authPlugin } from "../../plugins/auth";

/** 从 auth context 解析 bankId (member ID) */
async function getBankId(headers: Headers): Promise<string> {
  const { db } = await import("../../db");
  const { eq, and } = await import("drizzle-orm");
  const { member } = await import("../../db/schema");
  const { getAuthContext } = await import("../../services/org-context");

  const ctx = await getAuthContext(headers);
  const rows = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, ctx.organizationId),
        eq(member.userId, ctx.userId)
      )
    )
    .limit(1);
  if (!rows[0]) throw new Error("Member not found");
  return rows[0].id;
}

/** 构造 bank 路径前缀 */
function bankPath(bankId: string, suffix: string) {
  return `/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`;
}

const app = new Elysia({ name: "web-hindsight", prefix: "/hindsight" })
  .use(authPlugin)

  // ── Status ──
  .get("/status", async ({ request }) => {
    const config = getHindsightConfig();
    if (!config) return { success: true, data: { enabled: false } };
    // 同时返回 bankId 供前端使用
    try {
      const bankId = await getBankId(request.headers);
      return { success: true, data: { enabled: true, url: config.url, bankId } };
    } catch {
      return { success: true, data: { enabled: true, url: config.url } };
    }
  })

  // ── Memories ──
  .get("/memories", async ({ request, query }) => {
    const bankId = await getBankId(request.headers);
    const qs = new URLSearchParams(query as Record<string, string>).toString();
    const res = await proxyToHindsight(`/api/list?bank_id=${encodeURIComponent(bankId)}${qs ? `&${qs}` : ""}`);
    return res.json();
  })

  .post("/memories", async ({ request, body }) => {
    const bankId = await getBankId(request.headers);
    // retain 接口
    const res = await proxyToHindsight("/api/memories/retain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bank_id: bankId, ...(body as object) }),
    });
    return res.json();
  })

  .get("/memories/:id", async ({ request, params: { id } }) => {
    const bankId = await getBankId(request.headers);
    const res = await proxyToHindsight(`/api/memories/${encodeURIComponent(id)}?bank_id=${encodeURIComponent(bankId)}`);
    return res.json();
  })

  .delete("/memories/:id", async ({ request, params: { id } }) => {
    const bankId = await getBankId(request.headers);
    const res = await proxyToHindsight(`/api/memories/${encodeURIComponent(id)}?bank_id=${encodeURIComponent(bankId)}`, {
      method: "DELETE",
    });
    return res.json();
  })

  // ── Recall ──
  .post("/recall", async ({ request, body }) => {
    const bankId = await getBankId(request.headers);
    const res = await proxyToHindsight("/api/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bank_id: bankId, ...(body as object) }),
    });
    return res.json();
  })

  // ── Reflect ──
  .post("/reflect", async ({ request, body }) => {
    const bankId = await getBankId(request.headers);
    const res = await proxyToHindsight("/api/reflect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bank_id: bankId, ...(body as object) }),
    });
    return res.json();
  })

  // ── Documents ──
  .get("/documents", async ({ request, query }) => {
    const bankId = await getBankId(request.headers);
    const qs = new URLSearchParams({ bank_id: bankId, ...query as Record<string, string> }).toString();
    const res = await proxyToHindsight(`/api/documents?${qs}`);
    return res.json();
  })

  .post("/documents", async ({ request, body }) => {
    const bankId = await getBankId(request.headers);
    // 文档上传通过 multipart/form-data，需要透传
    const formData = body as FormData;
    const res = await proxyToHindsight(`/api/documents/upload?bank_id=${encodeURIComponent(bankId)}`, {
      method: "POST",
      body: formData,
    });
    return res.json();
  })

  .get("/documents/:id", async ({ request, params: { id } }) => {
    const bankId = await getBankId(request.headers);
    const res = await proxyToHindsight(`/api/documents/${encodeURIComponent(id)}?bank_id=${encodeURIComponent(bankId)}`);
    return res.json();
  })

  .delete("/documents/:id", async ({ request, params: { id } }) => {
    const bankId = await getBankId(request.headers);
    const res = await proxyToHindsight(`/api/documents/${encodeURIComponent(id)}?bank_id=${encodeURIComponent(bankId)}`, {
      method: "DELETE",
    });
    return res.json();
  })

  .get("/documents/:id/chunks", async ({ request, params: { id }, query }) => {
    const bankId = await getBankId(request.headers);
    const qs = new URLSearchParams({ bank_id: bankId, ...query as Record<string, string> }).toString();
    const res = await proxyToHindsight(`/api/documents/${encodeURIComponent(id)}/chunks?${qs}`);
    return res.json();
  })

  // ── Mental Models ──
  .get("/mental-models", async ({ request, query }) => {
    const bankId = await getBankId(request.headers);
    const qs = new URLSearchParams(query as Record<string, string>).toString();
    const res = await proxyToHindsight(`${bankPath(bankId, "/mental-models")}${qs ? `?${qs}` : ""}`);
    return res.json();
  })

  .get("/mental-models/:id", async ({ request, params: { id } }) => {
    const bankId = await getBankId(request.headers);
    const res = await proxyToHindsight(`${bankPath(bankId, `/mental-models/${encodeURIComponent(id)}`)}`);
    return res.json();
  })

  .delete("/mental-models/:id", async ({ request, params: { id } }) => {
    const bankId = await getBankId(request.headers);
    const res = await proxyToHindsight(`${bankPath(bankId, `/mental-models/${encodeURIComponent(id)}`)}`, {
      method: "DELETE",
    });
    return res.json();
  });

export default app;
```

- [ ] **Step 2: 运行测试**

Run: `bun test src/__tests__/hindsight-routes.test.ts`
Expected: PASS（现有测试仍通过，新端点尚未测试）

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/hindsight.ts
git commit -m "feat(hindsight): 扩展 proxy 路由 — memories/documents/mental-models/recall/reflect"
```

---

## Task 3: 后端 — Proxy 路由测试

**Files:**
- Modify: `src/__tests__/hindsight-routes.test.ts`

- [ ] **Step 1: 为新增 proxy 端点编写测试**

在现有测试文件中追加测试用例，覆盖：
- `GET /web/hindsight/status` 返回 bankId
- `GET /web/hindsight/memories` 需要 auth + 正确转发
- `POST /web/hindsight/recall` 需要带 bank_id
- `GET /web/hindsight/documents` 正确转发
- `GET /web/hindsight/mental-models` 正确转发

使用 stub 模式 mock `proxyToHindsight` 和 `resolveMemberId`。

- [ ] **Step 2: 运行测试确认通过**

Run: `bun test src/__tests__/hindsight-routes.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/hindsight-routes.test.ts
git commit -m "test(hindsight): 新增 proxy 路由测试"
```

---

## Task 4: 前端 — i18n 命名空间 + Sidebar 导航入口

**Files:**
- Create: `web/src/i18n/locales/en/hindsight.json`
- Create: `web/src/i18n/locales/zh/hindsight.json`
- Modify: `web/src/i18n/index.ts`
- Modify: `web/src/pages/agent-panel/AgentSidebarConfig.tsx`
- Modify: `web/src/i18n/locales/en/agentPanel.json`
- Modify: `web/src/i18n/locales/zh/agentPanel.json`

- [ ] **Step 1: 创建英文翻译文件**

```json
// web/src/i18n/locales/en/hindsight.json
{
  "title": "Memories",
  "description": "Agent memory management powered by Hindsight",
  "tabs": {
    "memories": "Memories",
    "documents": "Documents",
    "mentalModels": "Mental Models"
  },
  "memories": {
    "worldFacts": "World Facts",
    "experience": "Experience",
    "observations": "Observations",
    "search": "Search memories...",
    "recall": "Recall",
    "retain": "Retain",
    "reflect": "Reflect",
    "noMemories": "No memories found",
    "totalCount": "{{count}} memories",
    "detail": "Memory Detail",
    "tags": "Tags",
    "entities": "Entities",
    "context": "Context",
    "createdAt": "Created",
    "factType": "Type",
    "delete": "Delete",
    "deleteConfirm": "Are you sure you want to delete this memory?"
  },
  "documents": {
    "upload": "Upload Document",
    "search": "Search documents...",
    "noDocuments": "No documents found",
    "totalCount": "{{count}} documents",
    "chunks": "Chunks",
    "reprocess": "Reprocess",
    "delete": "Delete",
    "deleteConfirm": "Are you sure you want to delete this document and all its memories?"
  },
  "mentalModels": {
    "title": "Mental Models",
    "description": "Formed opinions and cognitive structures",
    "search": "Search mental models...",
    "noModels": "No mental models found",
    "totalCount": "{{count}} mental models",
    "confidence": "Confidence",
    "content": "Content",
    "stale": "Stale",
    "delete": "Delete",
    "detail": "Mental Model Detail"
  },
  "recall": {
    "query": "Query",
    "results": "Results",
    "noResults": "No results found",
    "searching": "Searching..."
  },
  "retain": {
    "content": "Content",
    "context": "Context",
    "tags": "Tags",
    "submit": "Retain"
  },
  "status": {
    "notConfigured": "Hindsight is not configured. Please set HINDSIGHT_MCP_URL.",
    "loading": "Loading..."
  }
}
```

- [ ] **Step 2: 创建中文翻译文件**

```json
// web/src/i18n/locales/zh/hindsight.json
{
  "title": "记忆",
  "description": "由 Hindsight 驱动的 Agent 记忆管理",
  "tabs": {
    "memories": "记忆",
    "documents": "文档",
    "mentalModels": "心理模型"
  },
  "memories": {
    "worldFacts": "世界事实",
    "experience": "经验",
    "observations": "观察",
    "search": "搜索记忆...",
    "recall": "召回",
    "retain": "存储",
    "reflect": "反思",
    "noMemories": "暂无记忆",
    "totalCount": "{{count}} 条记忆",
    "detail": "记忆详情",
    "tags": "标签",
    "entities": "实体",
    "context": "上下文",
    "createdAt": "创建时间",
    "factType": "类型",
    "delete": "删除",
    "deleteConfirm": "确定要删除这条记忆吗？"
  },
  "documents": {
    "upload": "上传文档",
    "search": "搜索文档...",
    "noDocuments": "暂无文档",
    "totalCount": "{{count}} 个文档",
    "chunks": "分块",
    "reprocess": "重新处理",
    "delete": "删除",
    "deleteConfirm": "确定要删除此文档及其所有记忆吗？"
  },
  "mentalModels": {
    "title": "心理模型",
    "description": "已形成的观点和认知结构",
    "search": "搜索心理模型...",
    "noModels": "暂无心理模型",
    "totalCount": "{{count}} 个心理模型",
    "confidence": "置信度",
    "content": "内容",
    "stale": "过期",
    "delete": "删除",
    "detail": "心理模型详情"
  },
  "recall": {
    "query": "查询",
    "results": "结果",
    "noResults": "未找到结果",
    "searching": "搜索中..."
  },
  "retain": {
    "content": "内容",
    "context": "上下文",
    "tags": "标签",
    "submit": "存储"
  },
  "status": {
    "notConfigured": "记忆能力未开启，请联系管理员进行记忆服务部署与配置",
    "loading": "加载中..."
  }
}
```

- [ ] **Step 3: 在 i18n/index.ts 注册命名空间**

在 `web/src/i18n/index.ts` 中：
1. 添加 import: `import hindsightEN from "./locales/en/hindsight.json";` 和对应 zh
2. 在 `NS` 对象中添加 `HINDSIGHT: "hindsight"`
3. 在 `resources.en` 和 `resources.zh` 中注册
4. 在 `ns` 数组中添加 `NS.HINDSIGHT`

- [ ] **Step 4: 在 Sidebar 添加 Memories 导航入口**

在 `web/src/pages/agent-panel/AgentSidebarConfig.tsx` 的 `NAV_GROUPS` 第二组（config）中添加：

```typescript
{ id: "memories", labelKey: "agentPanel:memories", icon: Brain },
```

需要在文件顶部 `import { Brain } from "lucide-react"`。

- [ ] **Step 5: 更新 agentPanel 翻译文件**

在 `web/src/i18n/locales/en/agentPanel.json` 中添加 `"memories": "Memories"`
在 `web/src/i18n/locales/zh/agentPanel.json` 中添加 `"memories": "记忆"`

- [ ] **Step 6: 运行 precheck**

Run: `bun run precheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/src/i18n/ web/src/pages/agent-panel/AgentSidebarConfig.tsx
git commit -m "feat(hindsight): 新增 i18n 命名空间 + Sidebar 导航入口"
```

---

## Task 5: 前端 — 类型定义 + API 客户端

**Files:**
- Create: `web/src/pages/hindsight/types.ts`
- Create: `web/src/api/hindsight.ts`

- [ ] **Step 1: 创建共享类型定义**

```typescript
// web/src/pages/hindsight/types.ts

/** 内存单元 */
export interface MemoryItem {
  id: string;
  text: string;
  context: string;
  date: string;
  fact_type: "world" | "experience" | "observation";
  mentioned_at: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  entities: string;
  chunk_id: string | null;
  proof_count: number;
  tags: string[];
  consolidated_at: string | null;
  consolidation_failed_at: string | null;
}

/** 内存列表响应 */
export interface MemoriesResponse {
  items: MemoryItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 内存详情 */
export interface MemoryDetail {
  id: string;
  text: string;
  context: string;
  date: string;
  type: string;
  mentioned_at: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  entities: string[];
  document_id: string | null;
  chunk_id: string | null;
  tags: string[];
  observation_scopes: string | string[][] | null;
}

/** 文档 */
export interface DocumentItem {
  document_id: string;
  bank_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  chunk_count: number;
  memory_unit_count: number;
  tags: string[];
}

/** 文档列表响应 */
export interface DocumentsResponse {
  items: DocumentItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 文档分块 */
export interface DocumentChunk {
  chunk_id: string;
  document_id: string;
  bank_id: string;
  chunk_index: number;
  chunk_text: string;
  created_at: string;
}

/** 心理模型 */
export interface MentalModel {
  id: string;
  bank_id: string;
  name: string;
  source_query: string;
  content: string;
  tags: string[];
  max_tokens: number;
  last_refreshed_at: string;
  created_at: string;
  is_stale?: boolean | null;
}

/** Recall 响应 */
export interface RecallResponse {
  facts: Array<{
    id: string;
    text: string;
    type: string;
    score: number;
  }>;
}

/** Reflect 响应 */
export interface ReflectResponse {
  answer: string;
  facts?: Array<{ id: string; text: string }>;
}

/** Status 响应 */
export interface HindsightStatus {
  enabled: boolean;
  url?: string;
  bankId?: string;
}
```

- [ ] **Step 2: 创建 API 客户端**

```typescript
// web/src/api/hindsight.ts

import type {
  DocumentsResponse,
  HindsightStatus,
  MemoriesResponse,
  MentalModel,
  MemoryDetail,
  RecallResponse,
  ReflectResponse,
} from "../pages/hindsight/types";

const BASE = "/web/hindsight";

/** 通用 fetch 封装 */
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(error.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export const hindsightApi = {
  /** 获取 Hindsight 状态 + bankId */
  getStatus: () => apiFetch<{ success: boolean; data: HindsightStatus }>("/status"),

  /** 列出内存 */
  listMemories: (params?: {
    type?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.type) qs.set("type", params.type);
    if (params?.q) qs.set("q", params.q);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    return apiFetch<MemoriesResponse>(`/memories?${qs.toString()}`);
  },

  /** 获取内存详情 */
  getMemory: (id: string) => apiFetch<MemoryDetail>(`/memories/${encodeURIComponent(id)}`),

  /** 删除内存 */
  deleteMemory: (id: string) =>
    apiFetch<{ success: boolean }>(`/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** Recall 搜索 */
  recall: (params: {
    query: string;
    types?: string[];
    max_tokens?: number;
  }) =>
    apiFetch<RecallResponse>("/recall", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  /** Reflect 反思 */
  reflect: (params: {
    query: string;
    max_tokens?: number;
  }) =>
    apiFetch<ReflectResponse>("/reflect", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  /** Retain 存储 */
  retain: (params: {
    items: Array<{
      content: string;
      context?: string;
      tags?: string[];
    }>;
  }) =>
    apiFetch<{ message?: string }>("/memories", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  /** 列出文档 */
  listDocuments: (params?: {
    q?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    return apiFetch<DocumentsResponse>(`/documents?${qs.toString()}`);
  },

  /** 上传文档 */
  uploadDocument: (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    return apiFetch<{ document_id: string }>("/documents", {
      method: "POST",
      // 不设 Content-Type，让浏览器自动设置 multipart boundary
      headers: {} as Record<string, string>,
      body: formData,
    });
  },

  /** 删除文档 */
  deleteDocument: (id: string) =>
    apiFetch<{ success: boolean }>(`/documents/${encodeURIComponent(id)}`, { method: "DELETE" }),

  /** 列出心理模型 */
  listMentalModels: () => apiFetch<{ items: MentalModel[] }>("/mental-models"),

  /** 删除心理模型 */
  deleteMentalModel: (id: string) =>
    apiFetch<{ success: boolean }>(`/mental-models/${encodeURIComponent(id)}`, { method: "DELETE" }),
};
```

- [ ] **Step 3: 运行 precheck**

Run: `bun run precheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/hindsight/types.ts web/src/api/hindsight.ts
git commit -m "feat(hindsight): 新增前端类型定义 + API 客户端"
```

---

## Task 6: 前端 — 主页面路由 + MemoriesPage 壳

**Files:**
- Create: `web/src/routes/agent/_panel/memories.tsx`
- Create: `web/src/pages/hindsight/MemoriesPage.tsx`

- [ ] **Step 1: 创建 TanStack Router 路由页面**

参考现有 `web/src/routes/agent/_panel/knowledge-bases.tsx` 的模式创建路由。

```typescript
// web/src/routes/agent/_panel/memories.tsx

import { createLazyFileRoute } from "@tanstack/react-router";
import { MemoriesPage } from "@/src/pages/hindsight/MemoriesPage";

export const Route = createLazyFileRoute("/agent/_panel/memories")({
  component: MemoriesPage,
});
```

- [ ] **Step 2: 创建 MemoriesPage 主页面**

主页面包含 Tab 切换和 Hindsight 状态检查。

```typescript
// web/src/pages/hindsight/MemoriesPage.tsx

import { Brain, FileText, Lightbulb } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NS } from "@/src/i18n";
import { hindsightApi } from "@/src/api/hindsight";
import { DataView } from "./components/DataView";
import { DocumentsView } from "./components/DocumentsView";
import { MentalModelsView } from "./components/MentalModelsView";

type TabValue = "memories" | "documents" | "mental-models";

export function MemoriesPage() {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [bankId, setBankId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);

  // 获取 Hindsight 状态
  useEffect(() => {
    hindsightApi
      .getStatus()
      .then((res) => {
        setEnabled(res.data.enabled);
        setBankId(res.data.bankId ?? null);
      })
      .catch((err) => {
        toast.error(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">{t("status.loading")}</p>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">{t("status.notConfigured")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 页面标题 */}
      <div className="px-6 py-4 border-b">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Brain className="w-5 h-5" />
          {t("title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t("description")}</p>
      </div>

      {/* Tab 内容 */}
      <Tabs defaultValue="memories" className="flex-1 flex flex-col overflow-hidden">
        <div className="px-6 border-b">
          <TabsList>
            <TabsTrigger value="memories">
              <Brain className="w-4 h-4 mr-1.5" />
              {t("tabs.memories")}
            </TabsTrigger>
            <TabsTrigger value="documents">
              <FileText className="w-4 h-4 mr-1.5" />
              {t("tabs.documents")}
            </TabsTrigger>
            <TabsTrigger value="mental-models">
              <Lightbulb className="w-4 h-4 mr-1.5" />
              {t("tabs.mentalModels")}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="memories" className="flex-1 overflow-auto">
          <DataView />
        </TabsContent>
        <TabsContent value="documents" className="flex-1 overflow-auto">
          <DocumentsView />
        </TabsContent>
        <TabsContent value="mental-models" className="flex-1 overflow-auto">
          <MentalModelsView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 3: 运行 precheck 确认路由注册**

Run: `bun run precheck`
Expected: PASS，TanStack Router 自动生成 `routeTree.gen.ts` 中的路由条目

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/agent/_panel/memories.tsx web/src/pages/hindsight/MemoriesPage.tsx web/src/routeTree.gen.ts
git commit -m "feat(hindsight): 新增 Memories 主页面路由 + Tab 壳"
```

---

## Task 7: 前端 — DataView 组件（核心内存视图）

**Files:**
- Create: `web/src/pages/hindsight/components/DataView.tsx`
- Create: `web/src/pages/hindsight/components/MemoryDetailPanel.tsx`
- Create: `web/src/pages/hindsight/components/RecallPanel.tsx`
- Create: `web/src/pages/hindsight/components/RetainDialog.tsx`
- Create: `web/src/pages/hindsight/components/CompactMarkdown.tsx`

**说明：** 这是最大最复杂的视图。从 Hindsight `data-view.tsx` (66KB) 精简改造。核心改造点：
1. API 调用 → `hindsightApi`
2. Radix 原生组件 → shadcn/ui
3. 去掉 bank-context 依赖
4. 添加 i18n
5. 保留核心功能：内存列表、过滤（fact_type）、搜索、recall、retain

- [ ] **Step 1: 创建 CompactMarkdown 工具组件**

从 Hindsight `compact-markdown.tsx` 复制并精简，去掉 next-intl 依赖。

- [ ] **Step 2: 创建 MemoryDetailPanel 组件**

从 Hindsight `memory-detail-panel.tsx` 改造：
- API → `hindsightApi.getMemory()`
- UI → shadcn Card/Badge
- i18n → `useTranslation(NS.HINDSIGHT)`

- [ ] **Step 3: 创建 RecallPanel 组件**

Recall 搜索面板：
- 输入框 + 搜索按钮
- 调用 `hindsightApi.recall()`
- 展示结果列表

- [ ] **Step 4: 创建 RetainDialog 组件**

Retain 创建内存对话框：
- 使用 shadcn Dialog
- 表单：content（必填）、context、tags
- 提交调用 `hindsightApi.retain()`

- [ ] **Step 5: 创建 DataView 主组件**

从 Hindsight `data-view.tsx` 改造。核心结构：

```typescript
// 简化后的 DataView 结构
export function DataView() {
  const { t } = useTranslation(NS.HINDSIGHT);

  // 状态
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [factType, setFactType] = useState<string>("world");
  const [search, setSearch] = useState("");
  const [selectedMemory, setSelectedMemory] = useState<string | null>(null);
  const [showRecall, setShowRecall] = useState(false);
  const [showRetain, setShowRetain] = useState(false);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

  // 加载数据
  const loadMemories = useCallback(async () => {
    setLoading(true);
    try {
      const res = await hindsightApi.listMemories({
        type: factType,
        q: search || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setMemories(res.items);
      setTotal(res.total);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load memories");
    } finally {
      setLoading(false);
    }
  }, [factType, search, page]);

  useEffect(() => { loadMemories(); }, [loadMemories]);

  // UI: fact_type 子 Tab + 搜索 + 列表 + 分页 + 右侧详情
  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-auto p-4">
        {/* 子 Tab: World Facts / Experience / Observations */}
        {/* 搜索栏 + Recall/Retain 按钮 */}
        {/* 内存列表 */}
        {/* 分页 */}
      </div>
      {selectedMemory && (
        <MemoryDetailPanel memoryId={selectedMemory} onClose={() => setSelectedMemory(null)} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: 运行 precheck**

Run: `bun run precheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/hindsight/components/
git commit -m "feat(hindsight): DataView 内存视图 — 列表/搜索/recall/retain/详情"
```

---

## Task 8: 前端 — DocumentsView 组件

**Files:**
- Create: `web/src/pages/hindsight/components/DocumentsView.tsx`

- [ ] **Step 1: 创建 DocumentsView 组件**

从 Hindsight `documents-view.tsx` 改造。核心功能：
- 文档列表（表格/卡片）
- 搜索过滤
- 文件上传（拖拽 + 按钮上传）
- 文档删除（确认对话框）
- 分页

```typescript
export function DocumentsView() {
  // 状态: documents, search, loading, page
  // 加载: hindsightApi.listDocuments()
  // 上传: hindsightApi.uploadDocument(file)
  // 删除: hindsightApi.deleteDocument(id) + ConfirmDialog
  // UI: 搜索栏 + 上传按钮 + 文档列表 + 分页
}
```

- [ ] **Step 2: 运行 precheck**

Run: `bun run precheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/hindsight/components/DocumentsView.tsx
git commit -m "feat(hindsight): DocumentsView 文档管理视图"
```

---

## Task 9: 前端 — MentalModelsView 组件

**Files:**
- Create: `web/src/pages/hindsight/components/MentalModelsView.tsx`
- Create: `web/src/pages/hindsight/components/MentalModelDetailModal.tsx`

- [ ] **Step 1: 创建 MentalModelDetailModal 组件**

从 Hindsight `mental-model-detail-modal.tsx` 改造：
- Dialog → shadcn Dialog
- API → `hindsightApi`
- i18n

- [ ] **Step 2: 创建 MentalModelsView 组件**

从 Hindsight `mental-models-view.tsx` 改造。核心功能：
- 心理模型列表（卡片布局）
- 搜索过滤
- 模型详情弹窗
- 删除（确认对话框）

```typescript
export function MentalModelsView() {
  // 状态: models, search, loading
  // 加载: hindsightApi.listMentalModels()
  // 删除: hindsightApi.deleteMentalModel(id)
  // UI: 搜索栏 + 模型卡片列表 + 点击展开详情弹窗
}
```

- [ ] **Step 3: 运行 precheck**

Run: `bun run precheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/hindsight/components/MentalModelsView.tsx web/src/pages/hindsight/components/MentalModelDetailModal.tsx
git commit -m "feat(hindsight): MentalModelsView 心理模型视图"
```

---

## Task 10: 端到端验证 + precheck

**Files:**
- 无新增

- [ ] **Step 1: 运行完整 precheck**

Run: `bun run precheck`
Expected: PASS（格式化 + import 排序 + tsc + biome check 全部通过）

- [ ] **Step 2: 运行全量后端测试**

Run: `bun test src/__tests__/`
Expected: PASS

- [ ] **Step 3: 运行前端构建**

Run: `bun run build:web`
Expected: 成功构建

- [ ] **Step 4: 手动验证页面可访问**

启动 `bun run dev`，访问 `/agent/memories`，确认：
- 页面正常渲染（未配置 Hindsight 时显示提示信息）
- Tab 切换正常
- Sidebar 导航项可见

- [ ] **Step 5: Final commit (if any fixes)**

```bash
git add -A
git commit -m "chore(hindsight): 端到端验证修复"
```
