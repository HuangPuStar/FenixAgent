import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { getHindsightConfig, proxyToHindsight, resolveMemberId } from "../../services/hindsight";

const app = new Elysia({ name: "web-hindsight", prefix: "/hindsight" })
  .use(authGuardPlugin)

  // ── Status ──────────────────────────────────────────────
  // 检查 Hindsight 配置状态，尝试解析 bankId
  .get("/status", async ({ store }) => {
    const config = getHindsightConfig();
    let bankId: string | null = null;
    if (config && store.authContext) {
      bankId = await resolveMemberId(store.authContext);
    }
    return {
      success: true as const,
      data: config ? { enabled: true, url: config.url, bankId } : { enabled: false },
    };
  })

  // ── Memories ────────────────────────────────────────────
  // 列出 memories
  .get(
    "/memories",
    async ({ query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      const qs = new URLSearchParams(query as Record<string, string>);
      qs.set("bank_id", bankId);
      try {
        const res = await proxyToHindsight(`/api/list?${qs.toString()}`);
        return await res.json();
      } catch (err) {
        console.error("[hindsight] GET /memories proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // 获取单个 memory
  .get(
    "/memories/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`/api/memories/${params.id}?bank_id=${encodeURIComponent(bankId)}`);
        return await res.json();
      } catch (err) {
        console.error("[hindsight] GET /memories/:id proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // 删除 memory
  .delete(
    "/memories/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`/api/memories/${params.id}?bank_id=${encodeURIComponent(bankId)}`, {
          method: "DELETE",
        });
        return await res.json();
      } catch (err) {
        console.error("[hindsight] DELETE /memories/:id proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // 创建/保留 memory（retain）
  .post(
    "/memories",
    async ({ body, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight("/api/memories/retain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bank_id: bankId, ...(body as Record<string, unknown>) }),
        });
        return await res.json();
      } catch (err) {
        console.error("[hindsight] POST /memories proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // POST /memories/graph — 获取内存图谱数据（Hindsight v1 API）
  .post(
    "/memories/graph",
    async ({ body, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`/v1/default/banks/${encodeURIComponent(bankId)}/memories/graph`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...(body as Record<string, unknown>) }),
        });
        return await res.json();
      } catch (err) {
        console.error("[hindsight] POST /memories/graph proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // GET /bank-stats — 获取 bank 统计信息（Hindsight v1 API）
  .get(
    "/bank-stats",
    async ({ store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`/v1/default/banks/${encodeURIComponent(bankId)}/stats`);
        return await res.json();
      } catch (err) {
        console.error("[hindsight] GET /bank-stats proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // ── Recall & Reflect ────────────────────────────────────
  // Recall: 语义检索记忆
  .post(
    "/recall",
    async ({ body, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight("/api/recall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bank_id: bankId, ...(body as Record<string, unknown>) }),
        });
        return await res.json();
      } catch (err) {
        console.error("[hindsight] POST /recall proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // Reflect: 触发反思/整合
  .post(
    "/reflect",
    async ({ body, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight("/api/reflect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bank_id: bankId, ...(body as Record<string, unknown>) }),
        });
        return await res.json();
      } catch (err) {
        console.error("[hindsight] POST /reflect proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // ── Documents ───────────────────────────────────────────
  // 列出文档
  .get(
    "/documents",
    async ({ query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      const qs = new URLSearchParams(query as Record<string, string>);
      qs.set("bank_id", bankId);
      try {
        const res = await proxyToHindsight(`/api/documents?${qs.toString()}`);
        return await res.json();
      } catch (err) {
        console.error("[hindsight] GET /documents proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // 删除文档
  .delete(
    "/documents/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`/api/documents/${params.id}?bank_id=${encodeURIComponent(bankId)}`, {
          method: "DELETE",
        });
        return await res.json();
      } catch (err) {
        console.error("[hindsight] DELETE /documents/:id proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // 获取文档分块
  .get(
    "/documents/:id/chunks",
    async ({ params, query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      const qs = new URLSearchParams(query as Record<string, string>);
      qs.set("bank_id", bankId);
      try {
        const res = await proxyToHindsight(`/api/documents/${params.id}/chunks?${qs.toString()}`);
        return await res.json();
      } catch (err) {
        console.error("[hindsight] GET /documents/:id/chunks proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // ── Mental Models ───────────────────────────────────────
  // 列出 mental models（v1 API）
  .get(
    "/mental-models",
    async ({ store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`/v1/default/banks/${encodeURIComponent(bankId)}/mental-models`);
        return await res.json();
      } catch (err) {
        console.error("[hindsight] GET /mental-models proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // 获取单个 mental model
  .get(
    "/mental-models/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(
          `/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${params.id}`,
        );
        return await res.json();
      } catch (err) {
        console.error("[hindsight] GET /mental-models/:id proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // 删除 mental model
  .delete(
    "/mental-models/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(
          `/v1/default/banks/${encodeURIComponent(bankId)}/mental-models/${params.id}`,
          {
            method: "DELETE",
          },
        );
        return await res.json();
      } catch (err) {
        console.error("[hindsight] DELETE /mental-models/:id proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // ── Entities ────────────────────────────────────────────
  // 列出实体
  .get(
    "/entities",
    async ({ query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      const qs = new URLSearchParams(query as Record<string, string>);
      qs.set("bank_id", bankId);
      try {
        const res = await proxyToHindsight(`/api/entities?${qs.toString()}`);
        return await res.json();
      } catch (err) {
        console.error("[hindsight] GET /entities proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // 获取单个实体详情
  .get(
    "/entities/:id",
    async ({ params, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      try {
        const res = await proxyToHindsight(`/api/entities/${params.id}?bank_id=${encodeURIComponent(bankId)}`);
        return await res.json();
      } catch (err) {
        console.error("[hindsight] GET /entities/:id proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  )

  // 获取实体共现图谱
  .get(
    "/entities/graph",
    async ({ query, store, error }) => {
      const bankId = await resolveMemberId(store.authContext!);
      if (!bankId) return error(403, { error: { type: "forbidden", message: "Cannot resolve bank ID" } });
      const qs = new URLSearchParams(query as Record<string, string>);
      qs.set("bank_id", bankId);
      try {
        const res = await proxyToHindsight(`/api/entities/graph?${qs.toString()}`);
        return await res.json();
      } catch (err) {
        console.error("[hindsight] GET /entities/graph proxy failed:", err);
        return error(503, { error: { type: "service_unavailable", message: "Hindsight service unavailable" } });
      }
    },
    { sessionAuth: true },
  );

export default app;
