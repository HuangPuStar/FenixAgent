import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { HindsightStatusResponseSchema } from "../../schemas";
import { configSuccess } from "../../services/config-utils";
import { getHindsightConfig, proxyToHindsight, resolveMemberId } from "../../services/hindsight";

/** 构造 Hindsight v1 bank 路径前缀：/v1/default/banks/{bankId} */
const bankPath = (bankId: string) => `/v1/default/banks/${encodeURIComponent(bankId)}`;

/** 拼接 query string，空参数返回原始 base */
const withQs = (base: string, query: Record<string, string>) => {
  const qs = new URLSearchParams(query);
  return qs.toString() ? `${base}?${qs.toString()}` : base;
};

const app = new Elysia({ name: "web-hindsight", prefix: "/hindsight" })
  .use(authGuardPlugin)
  .model({
    "hindsight-status-response": HindsightStatusResponseSchema,
  })

  // ── Status ──────────────────────────────────────────────
  // 检查 Hindsight 配置状态，尝试解析 bankId
  .get(
    "/status",
    async ({ store }) => {
      const config = getHindsightConfig();
      let bankId: string | null = null;
      if (config && store.authContext) {
        bankId = await resolveMemberId(store.authContext);
      }
      return {
        success: true as const,
        data: config
          ? ({ enabled: true as const, url: config.url, bankId } as const)
          : ({ enabled: false as const } as const),
      };
    },
    {
      response: "hindsight-status-response",
      detail: {
        tags: ["Hindsight"],
        summary: "获取 Hindsight 状态",
        description: "返回当前 Hindsight 服务是否已启用，以及启用时对应的服务地址和当前用户映射的 bankId。",
      },
    },
  )

  // ── Graph ───────────────────────────────────────────────
  // 获取内存图谱数据，GET 方法，参数通过 query string 传递
  .get(
    "/graph",
    async ({ query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(withQs(`${bankPath(bankId)}/graph`, query as Record<string, string>));
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /graph proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "获取记忆图谱",
        description: "代理查询当前用户对应 Hindsight bank 的图谱数据，请求参数会原样透传给 Hindsight 服务。",
      },
    },
  )

  // ── Bank Stats ──────────────────────────────────────────
  .get(
    "/bank-stats",
    async ({ store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/stats`);
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /bank-stats proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "获取记忆库统计信息",
        description: "返回当前用户对应 Hindsight bank 的统计信息，例如记忆数量、文档数量等汇总数据。",
      },
    },
  )

  // ── Memories ────────────────────────────────────────────
  // 列出 memories：转发到 /v1/.../memories/list
  .get(
    "/memories",
    async ({ query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(
          withQs(`${bankPath(bankId)}/memories/list`, query as Record<string, string>),
        );
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /memories proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "查询记忆列表",
        description: "代理查询当前用户对应 Hindsight bank 的记忆列表，分页、过滤等 query 参数会直接透传给上游服务。",
      },
    },
  )

  // 获取单个 memory
  .get(
    "/memories/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/memories/${params.id}`);
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /memories/:id proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "获取记忆详情",
        description: "根据记忆 ID 查询单条记忆详情，路径参数中的 `id` 会映射到 Hindsight 上游记忆记录。",
      },
    },
  )

  // 删除 memory
  .delete(
    "/memories/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/memories/${params.id}`, { method: "DELETE" });
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] DELETE /memories/:id proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "删除记忆",
        description: "根据记忆 ID 删除当前用户对应 Hindsight bank 中的一条记忆记录。",
      },
    },
  )

  // 创建/保留 memory（retain），body 直接透传（不再注入 bank_id）
  .post(
    "/memories",
    async ({ body, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/memories`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] POST /memories proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "创建记忆",
        description: "向当前用户对应的 Hindsight bank 写入一条新的记忆记录，请求体会按原样透传给上游服务。",
      },
    },
  )

  // ── Recall & Reflect ────────────────────────────────────
  // Recall: 语义检索记忆，转发到 /v1/.../memories/recall
  .post(
    "/recall",
    async ({ body, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/memories/recall`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] POST /recall proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "检索相关记忆",
        description: "根据输入内容触发 Hindsight 记忆召回，请求体中的检索条件会透传给上游 recall 接口。",
      },
    },
  )

  // Reflect: 触发反思/整合，转发到 /v1/.../reflect
  .post(
    "/reflect",
    async ({ body, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/reflect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] POST /reflect proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "触发记忆反思",
        description: "触发 Hindsight 对当前记忆库执行反思或整合流程，请求体会原样透传给上游 reflect 接口。",
      },
    },
  )

  // ── Documents ───────────────────────────────────────────
  // 列出文档
  .get(
    "/documents",
    async ({ query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(withQs(`${bankPath(bankId)}/documents`, query as Record<string, string>));
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /documents proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "查询文档列表",
        description: "代理查询当前用户对应 Hindsight bank 中已上传的文档列表，query 参数会透传给上游服务。",
      },
    },
  )

  // 上传文档（multipart/form-data 转发）
  .post(
    "/documents",
    async ({ body, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        // Elysia 自动解析 multipart body，重构 FormData 转发给 Hindsight
        const fd = new FormData();
        const parsed = body as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (value instanceof Blob) {
            fd.append(key, value);
          } else if (typeof value === "string") {
            fd.append(key, value);
          }
        }
        const res = await proxyToHindsight(`${bankPath(bankId)}/documents`, {
          method: "POST",
          body: fd,
        });
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] POST /documents proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "上传文档",
        description:
          "以 multipart/form-data 方式向当前用户对应 Hindsight bank 上传文档，表单字段会重组后转发给上游服务。",
      },
    },
  )

  // 删除文档
  .delete(
    "/documents/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/documents/${params.id}`, { method: "DELETE" });
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] DELETE /documents/:id proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "删除文档",
        description: "根据文档 ID 删除当前用户对应 Hindsight bank 中的文档记录。",
      },
    },
  )

  // 获取文档分块
  .get(
    "/documents/:id/chunks",
    async ({ params, query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(
          withQs(`${bankPath(bankId)}/documents/${params.id}/chunks`, query as Record<string, string>),
        );
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /documents/:id/chunks proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "查询文档分块",
        description: "根据文档 ID 查询切分后的文档块内容，query 参数会透传给 Hindsight 上游接口。",
      },
    },
  )

  // ── Mental Models ───────────────────────────────────────
  // 列出 mental models
  .get(
    "/mental-models",
    async ({ store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/mental-models`);
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /mental-models proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "查询心智模型列表",
        description: "返回当前用户对应 Hindsight bank 中提炼出的心智模型列表。",
      },
    },
  )

  // 获取单个 mental model
  .get(
    "/mental-models/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/mental-models/${params.id}`);
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /mental-models/:id proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "获取心智模型详情",
        description: "根据心智模型 ID 查询单条心智模型详情。",
      },
    },
  )

  // 删除 mental model
  .delete(
    "/mental-models/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/mental-models/${params.id}`, { method: "DELETE" });
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] DELETE /mental-models/:id proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "删除心智模型",
        description: "根据心智模型 ID 删除当前用户对应 Hindsight bank 中的一条心智模型记录。",
      },
    },
  )

  // ── Entities ────────────────────────────────────────────
  // 列出实体
  .get(
    "/entities",
    async ({ query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(withQs(`${bankPath(bankId)}/entities`, query as Record<string, string>));
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /entities proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "查询实体列表",
        description: "代理查询当前用户对应 Hindsight bank 中抽取出的实体列表，query 参数会原样透传给上游服务。",
      },
    },
  )

  // 获取单个实体详情
  .get(
    "/entities/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`${bankPath(bankId)}/entities/${params.id}`);
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /entities/:id proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "获取实体详情",
        description: "根据实体 ID 查询单个实体的详情信息。",
      },
    },
  )

  // 获取实体共现图谱
  .get(
    "/entities/graph",
    async ({ query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId)
        return error(403, { success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(
          withQs(`${bankPath(bankId)}/entities/graph`, query as Record<string, string>),
        );
        return configSuccess(await res.json());
      } catch (err) {
        console.error("[hindsight] GET /entities/graph proxy failed:", err);
        return error(503, {
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        });
      }
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Hindsight"],
        summary: "获取实体关系图谱",
        description: "代理查询当前用户对应 Hindsight bank 的实体关系图谱数据，query 参数会直接透传给上游服务。",
      },
    },
  );

export default app;
