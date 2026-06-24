import { eq } from "drizzle-orm";
import Elysia from "elysia";
import { db } from "../../db";
import { agentConfigSiteApp } from "../../db/schema";
import { authGuardPlugin } from "../../plugins/auth";
import type { AgentSiteAppRow } from "../../repositories/agent-site-app";
import { agentSiteAppRepo } from "../../repositories/agent-site-app";
import { CreateAgentSiteAppRequestSchema, UpdateAgentSiteAppRequestSchema } from "../../schemas/agent-site.schema";
import {
  createRemoteApp,
  deleteRemoteApp,
  issuePlatformToken,
  proxyToAgentSites,
  revokePlatformToken,
  uploadRemoteBundle,
  uploadRemoteFile,
} from "../../services/agent-sites";
import { addAgentSiteApp, getAgentConfigById, removeAgentSiteApp } from "../../services/config";

/** 将 DB row 转为 API 响应（秒级时间戳，不包含 platformToken） */
function toResponse(row: AgentSiteAppRow) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    remoteAppId: row.remoteAppId,
    name: row.name,
    description: row.description ?? null,
    visibility: row.visibility ?? "private",
    createdAt: row.createdAt ? Math.floor(new Date(row.createdAt).getTime() / 1000) : 0,
    updatedAt: row.updatedAt ? Math.floor(new Date(row.updatedAt).getTime() / 1000) : 0,
  };
}

/** 判断当前用户是否对 app 有写权限（owner 或 org admin） */
function canWrite(row: { userId: string }, userId: string, role: string): boolean {
  return row.userId === userId || role === "owner" || role === "admin";
}

const app = new Elysia({ name: "web-agent-sites", prefix: "/agent-sites" })
  .use(authGuardPlugin)
  .model({
    "create-agent-site-app-request": CreateAgentSiteAppRequestSchema,
    "update-agent-site-app-request": UpdateAgentSiteAppRequestSchema,
  })

  // ── L1: App CRUD ────────────────────────────────────

  .get(
    "/apps",
    async ({ store }) => {
      const authCtx = store.authContext!;
      const rows = await agentSiteAppRepo.listByOrg(authCtx.organizationId);
      return { success: true as const, data: rows.map(toResponse) };
    },
    {
      sessionAuth: true,

      detail: {
        tags: ["Agent Sites"],
        summary: "获取 agent sites app 列表",
        description: "返回当前组织下所有 app。",
      },
    },
  )

  .get(
    "/apps/:id",
    async ({ params, store, error }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: "App 不存在" } });
      }
      return { success: true as const, data: toResponse(row) };
    },
    {
      sessionAuth: true,

      detail: {
        tags: ["Agent Sites"],
        summary: "获取 agent site app 详情",
        description: "返回单个 app 的详细信息。",
      },
    },
  )

  .post(
    "/apps",
    async ({ store, body }) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      const b = body as { name: string; description?: string; visibility?: string };

      // 1. 在 agent-sites 创建远程 app
      const remote = await createRemoteApp(b.name);

      // 2. 申请 platform token
      const token = await issuePlatformToken(remote.id);

      // 3. 写入 RCS DB
      const row = await agentSiteAppRepo.create({
        organizationId: authCtx.organizationId,
        userId: user.id,
        remoteAppId: remote.id,
        name: remote.name,
        description: b.description,
        platformToken: token.token,
        platformTokenId: token.token_id,
        visibility: (b.visibility as "private" | "org" | "authenticated" | "public") ?? "private",
      });

      return { success: true as const, data: toResponse(row) };
    },
    {
      sessionAuth: true,
      body: "create-agent-site-app-request",

      detail: {
        tags: ["Agent Sites"],
        summary: "创建 agent site app",
        description: "在 agent-sites 创建远程 app + 申请 token + 写 RCS DB。",
      },
    },
  )

  .patch(
    "/apps/:id",
    async ({ params, store, body, error }) => {
      const authCtx = store.authContext!;
      const b = body as { name?: string; description?: string; visibility?: string };
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: "App 不存在" } });
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return error(403, { error: { type: "forbidden", message: "无权限修改此 app" } });
      }
      const updated = await agentSiteAppRepo.update(params.id, {
        name: b.name,
        description: b.description,
        visibility: b.visibility as "private" | "org" | "authenticated" | "public" | undefined,
      });
      return { success: true as const, data: toResponse(updated!) };
    },
    {
      sessionAuth: true,
      body: "update-agent-site-app-request",

      detail: {
        tags: ["Agent Sites"],
        summary: "更新 agent site app",
        description: "修改 app 名称、描述或可见性。owner/admin 可操作。",
      },
    },
  )

  .delete(
    "/apps/:id",
    async ({ params, store, error }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: "App 不存在" } });
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return error(403, { error: { type: "forbidden", message: "无权限删除此 app" } });
      }
      // 先调 agent-sites 删除远程 app
      await deleteRemoteApp(row.remoteAppId);
      // 再 RCS DB hard delete
      await agentSiteAppRepo.delete(params.id);
      return { success: true as const };
    },
    {
      sessionAuth: true,

      detail: {
        tags: ["Agent Sites"],
        summary: "删除 agent site app",
        description: "删除远程 app + RCS DB 硬删除。owner/admin 可操作。",
      },
    },
  )

  // ── L1: Token 管理 ──────────────────────────────────

  .post(
    "/apps/:id/rotate-token",
    async ({ params, store, error }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: "App 不存在" } });
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return error(403, { error: { type: "forbidden", message: "无权限操作此 app" } });
      }
      try {
        await revokePlatformToken(row.platformTokenId);
      } catch {
        console.warn(`[agent-sites] 吊销旧 token 失败 tokenId=${row.platformTokenId}，继续申请新 token`);
      }
      const token = await issuePlatformToken(row.remoteAppId);
      await agentSiteAppRepo.update(params.id, {
        platformToken: token.token,
        platformTokenId: token.token_id,
      });
      return { success: true as const };
    },
    {
      sessionAuth: true,

      detail: {
        tags: ["Agent Sites"],
        summary: "重签 platform token",
        description: "吊销旧 token + 申请新 token + 更新 DB。owner/admin 可操作。",
      },
    },
  )

  // ── L1: 文件上传 ────────────────────────────────────

  .put(
    "/apps/:id/files/:path",
    async ({ params, request, store, error }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: "App 不存在" } });
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return error(403, { error: { type: "forbidden", message: "无权限上传文件" } });
      }
      const result = await uploadRemoteFile(row.remoteAppId, params.path, request.body);
      return { success: true as const, data: result.data };
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Agent Sites"],
        summary: "上传前端静态文件",
        description: "单文件上传到 agent-sites。owner/admin 可操作。",
      },
    },
  )

  .post(
    "/apps/:id/files/bundle",
    async ({ params, request, store, error }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: "App 不存在" } });
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return error(403, { error: { type: "forbidden", message: "无权限上传文件" } });
      }
      const result = await uploadRemoteBundle(row.remoteAppId, request.body);
      return { success: true as const, data: result.data };
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Agent Sites"],
        summary: "批量上传前端文件",
        description: "gzip tar 批量上传到 agent-sites。owner/admin 可操作。",
      },
    },
  )

  // ── L1.5: AgentConfig ↔ SiteApp 绑定查询 ───────────
  // chat 右侧 ArtifactsPanel 通过 agentConfigId 拉取绑定的 sites 详情，
  // 用于顶部 Files / Site1 / Site2 tab 切换。返回顺序按绑定 createdAt 升序，
  // 与 AgentFormDialog 中勾选顺序一致，确保 UI 展示稳定。

  .get(
    "/agent-configs/:agentConfigId/sites",
    async ({ params, store }) => {
      const authCtx = store.authContext!;
      const siteAppIdsRows = await db
        .select({ siteAppId: agentConfigSiteApp.siteAppId })
        .from(agentConfigSiteApp)
        .where(eq(agentConfigSiteApp.agentConfigId, params.agentConfigId));
      const siteAppIds = siteAppIdsRows.map((r) => r.siteAppId);
      if (siteAppIds.length === 0) {
        return { success: true as const, data: [] };
      }
      const apps = await agentSiteAppRepo.listByIds(siteAppIds, authCtx.organizationId);
      // 保持绑定顺序（与勾选顺序一致，UI 展示稳定）
      const ordered = siteAppIds.map((id) => apps.find((a) => a.id === id)).filter((a): a is AgentSiteAppRow => !!a);
      return { success: true as const, data: ordered.map(toResponse) };
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Agent Sites"],
        summary: "获取 agent 绑定的 sites",
        description: "按 agentConfigId 返回绑定的 site app 详情列表（按绑定顺序）。",
      },
    },
  )

  // ── L1.5: AgentConfig ↔ SiteApp 单点绑定/解绑 ───────
  // chat 右侧 Sites tab 的 + / × 按钮直接调这两个接口，绑定/解绑立即写 DB 生效，
  // 无需重启 agent 实例（绑定关系仅前端 ArtifactsPanel 查 DB 使用）。
  // 双重组织校验：agentConfig + siteApp 都必须在当前组织内，防御性兜底。
  // 重复绑定走 PK 联合唯一 + ON CONFLICT DO NOTHING，幂等成功。

  .post(
    "/agent-configs/:agentConfigId/sites/:siteAppId",
    async ({ params, store, error }) => {
      const authCtx = store.authContext!;
      const agentConfig = await getAgentConfigById(params.agentConfigId, authCtx.organizationId);
      if (!agentConfig) {
        return error(404, { error: { type: "not_found", message: "Agent 配置不存在" } });
      }
      const siteApp = await agentSiteAppRepo.getById(params.siteAppId);
      if (!siteApp || siteApp.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: "Site 不存在" } });
      }
      await addAgentSiteApp(params.agentConfigId, params.siteAppId);
      return { success: true as const };
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Agent Sites"],
        summary: "挂载单个 site 到 agent",
        description: "单点绑定，PK 联合唯一保证幂等。chat 右侧 Sites tab 的 + 按钮调用。",
      },
    },
  )

  .delete(
    "/agent-configs/:agentConfigId/sites/:siteAppId",
    async ({ params, store, error }) => {
      const authCtx = store.authContext!;
      const agentConfig = await getAgentConfigById(params.agentConfigId, authCtx.organizationId);
      if (!agentConfig) {
        return error(404, { error: { type: "not_found", message: "Agent 配置不存在" } });
      }
      const siteApp = await agentSiteAppRepo.getById(params.siteAppId);
      if (!siteApp || siteApp.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: "Site 不存在" } });
      }
      await removeAgentSiteApp(params.agentConfigId, params.siteAppId);
      return { success: true as const };
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Agent Sites"],
        summary: "从 agent 卸载单个 site",
        description: "单点解绑，DELETE 天然幂等。chat 右侧 Sites tab 的 × 按钮调用。",
      },
    },
  )

  // ── L2: PB Admin API 透传 ────────────────────────────
  // 用 * 捕获完整子路径（:path 只取一段，/api/collections/cards 会丢 /cards）
  .all(
    "/apps/:id/api/*",
    async ({ params, request, store, error }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return error(404, { error: { type: "not_found", message: "App 不存在" } });
      }
      // 提取 prefix 之后的相对路径，拼回 /api/ 前缀
      const prefix = `/web/agent-sites/apps/${params.id}/api/`;
      const url = new URL(request.url);
      const relative = url.pathname.substring(url.pathname.indexOf(prefix) + prefix.length);
      const apiPath = `/api/${relative}`;
      return proxyToAgentSites(row.remoteAppId, apiPath, request, {
        Authorization: `Bearer ${row.platformToken}`,
      });
    },
    {
      sessionAuth: true,
      detail: {
        hide: true,
        tags: ["Agent Sites"],
        summary: "透传 PB Admin API",
        description: "注入 platform token 后透传到 agent-sites PB API。任何 org 成员可调。",
      },
    },
  );

export default app;
