import { eq } from "drizzle-orm";
import Elysia from "elysia";
import * as z from "zod/v4";
import { db } from "../../db";
import { agentConfigSiteApp } from "../../db/schema";
import { authGuardPlugin } from "../../plugins/auth";
import type { AgentSiteAppRow } from "../../repositories/agent-site-app";
import { agentSiteAppRepo } from "../../repositories/agent-site-app";
import {
  AgentSiteAgentConfigParamsSchema,
  type AgentSiteApp,
  AgentSiteAppDetailResponseSchema,
  AgentSiteAppFileParamsSchema,
  AgentSiteAppIdParamsSchema,
  AgentSiteAppListResponseSchema,
  AgentSiteAppOkResponseSchema,
  AgentSiteBindingParamsSchema,
  AgentSiteDeployResponseSchema,
  AgentSiteRemoteAppParamsSchema,
  type CreateAgentSiteAppRequest,
  CreateAgentSiteAppRequestSchema,
  type UpdateAgentSiteAppRequest,
  UpdateAgentSiteAppRequestSchema,
} from "../../schemas/agent-site.schema";
import type { WebErr } from "../../schemas/common.schema";
import { WebErrSchema, WebOkSchema } from "../../schemas/common.schema";
import {
  createRemoteApp,
  deleteRemoteApp,
  deployCustomApp,
  issuePlatformToken,
  proxyToAgentSites,
  revokePlatformToken,
  uploadRemoteBundle,
  uploadRemoteFile,
} from "../../services/agent-sites";
import { addAgentSiteApp, getAgentConfigById, removeAgentSiteApp } from "../../services/config";
import { invalidateAppCache } from "../agent-sites-proxy";

/** 将 DB row 转为 API 响应（秒级时间戳，不包含 platformToken） */
function toResponse(row: AgentSiteAppRow): AgentSiteApp {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    remoteAppId: row.remoteAppId,
    name: row.name,
    description: row.description ?? null,
    visibility: (row.visibility as AgentSiteApp["visibility"] | undefined) ?? "private",
    appType: (row.appType as AgentSiteApp["appType"] | undefined) ?? "pocketbase",
    entryFile: row.entryFile ?? null,
    activeSlot: (row.activeSlot as AgentSiteApp["activeSlot"] | undefined) ?? null,
    deployedAt: row.deployedAt ? Math.floor(row.deployedAt.getTime() / 1000) : null,
    createdAt: row.createdAt ? Math.floor(new Date(row.createdAt).getTime() / 1000) : 0,
    updatedAt: row.updatedAt ? Math.floor(new Date(row.updatedAt).getTime() / 1000) : 0,
  };
}

/** 判断当前用户是否对 app 有写权限（owner 或 org admin） */
function canWrite(row: { userId: string }, userId: string, role: string): boolean {
  return row.userId === userId || role === "owner" || role === "admin";
}

/**
 * 判断当前用户是否可以在管理界面看到该 app。
 * 管理 API 已是 org 隔离，只需对 private 可见性的 app 做 userId 过滤。
 */
function canRead(row: AgentSiteAppRow, userId: string): boolean {
  if (row.visibility !== "private") return true;
  return row.userId === userId;
}

/** 识别 siteAppId 格式并查找：UUID 格式走 getById，否则走 getByRemoteAppId。
 *  必须区分格式再查，因为 getById 对非 UUID 参数会直接抛 PG 类型异常，不会返回 undefined。 */
async function resolveSiteApp(siteAppId: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteAppId);
  return isUuid ? agentSiteAppRepo.getById(siteAppId) : agentSiteAppRepo.getByRemoteAppId(siteAppId);
}

/**
 * 构造统一的 /web 错误体，交给 Elysia `status()` 标注状态码。
 */
function buildError(code: string, message: string): WebErr {
  return {
    success: false,
    error: {
      code,
      message,
    },
  };
}

const app = new Elysia({ name: "web-agent-sites", prefix: "/agent-sites" })
  .use(authGuardPlugin)

  // ── L1: App CRUD ────────────────────────────────────

  .get(
    "/apps",
    async ({ store }) => {
      const authCtx = store.authContext!;
      const rows = await agentSiteAppRepo.listByOrg(authCtx.organizationId);
      const visible = rows.filter((r) => canRead(r, authCtx.userId));
      return { success: true as const, data: visible.map(toResponse) };
    },
    {
      sessionAuth: true,
      response: AgentSiteAppListResponseSchema,
      detail: {
        tags: ["Agent Sites"],
        summary: "获取 agent sites app 列表",
        description: "返回当前组织下所有 app。",
      },
    },
  )

  .get(
    "/apps/:id",
    async ({ params, store, status }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId || !canRead(row, authCtx.userId)) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      return { success: true as const, data: toResponse(row) };
    },
    {
      sessionAuth: true,
      params: AgentSiteAppIdParamsSchema,
      response: {
        200: AgentSiteAppDetailResponseSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Agent Sites"],
        summary: "获取 agent site app 详情",
        description: "根据 RCS 内 app UUID 返回单个 app 的详细信息。",
      },
    },
  )

  .get(
    "/apps/by-remote/:remoteAppId",
    async ({ params, store, status }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getByRemoteAppId(params.remoteAppId);
      if (!row || row.organizationId !== authCtx.organizationId || !canRead(row, authCtx.userId)) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      return { success: true as const, data: toResponse(row) };
    },
    {
      sessionAuth: true,
      params: AgentSiteRemoteAppParamsSchema,
      response: {
        200: AgentSiteAppDetailResponseSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Agent Sites"],
        summary: "按远端 app id 获取 agent site app 详情",
        description: "根据 agent-sites 远程 app id 返回单个 app 的详细信息，用于聊天卡片和站点识别链路。",
      },
    },
  )

  .post(
    "/apps",
    async ({ store, body }) => {
      const authCtx = store.authContext!;
      const user = store.user!;
      const b = body as CreateAgentSiteAppRequest;

      // 1. 在 agent-sites 创建远程 app（透传 type，默认 pocketbase）
      const remote = await createRemoteApp(b.name, b.type);

      // 2. 申请 platform token（custom 类型其实用不到 token——没有 PB，
      //    但保留以保持 RCS DB schema 一致；后续如需迁移回 pocketbase 也无缝）
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
        appType: b.type,
      });

      return { success: true as const, data: toResponse(row) };
    },
    {
      sessionAuth: true,
      body: CreateAgentSiteAppRequestSchema,
      response: AgentSiteAppDetailResponseSchema,
      detail: {
        tags: ["Agent Sites"],
        summary: "创建 agent site app",
        description: "在 agent-sites 创建远程 app + 申请 token + 写 RCS DB。type=custom 时不创建 PocketBase。",
      },
    },
  )

  .patch(
    "/apps/:id",
    async ({ params, store, body, status }) => {
      const authCtx = store.authContext!;
      const b = body as UpdateAgentSiteAppRequest;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return status(403, buildError("forbidden", "无权限修改此 app"));
      }
      const updated = await agentSiteAppRepo.update(params.id, {
        name: b.name,
        description: b.description,
        visibility: b.visibility as "private" | "org" | "authenticated" | "public" | undefined,
      });
      // 更新 visibility 后立即使代理缓存失效，避免旧权限继续生效最多 60s
      if (b.visibility !== undefined) {
        invalidateAppCache(updated!.remoteAppId);
      }
      return { success: true as const, data: toResponse(updated!) };
    },
    {
      sessionAuth: true,
      params: AgentSiteAppIdParamsSchema,
      body: UpdateAgentSiteAppRequestSchema,
      response: {
        200: AgentSiteAppDetailResponseSchema,
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Agent Sites"],
        summary: "更新 agent site app",
        description: "修改 app 名称、描述或可见性。owner/admin 可操作。",
      },
    },
  )

  .delete(
    "/apps/:id",
    async ({ params, store, status }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return status(403, buildError("forbidden", "无权限删除此 app"));
      }
      // 先调 agent-sites 删除远程 app
      await deleteRemoteApp(row.remoteAppId);
      // 再 RCS DB hard delete
      await agentSiteAppRepo.delete(params.id);
      return { success: true as const, data: null };
    },
    {
      sessionAuth: true,
      params: AgentSiteAppIdParamsSchema,
      response: {
        200: AgentSiteAppOkResponseSchema,
        403: WebErrSchema,
        404: WebErrSchema,
      },
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
    async ({ params, store, status }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return status(403, buildError("forbidden", "无权限操作此 app"));
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
      return { success: true as const, data: null };
    },
    {
      sessionAuth: true,
      params: AgentSiteAppIdParamsSchema,
      response: {
        200: AgentSiteAppOkResponseSchema,
        403: WebErrSchema,
        404: WebErrSchema,
      },
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
    async ({ params, request, store, status }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return status(403, buildError("forbidden", "无权限上传文件"));
      }
      const result = await uploadRemoteFile(row.remoteAppId, params.path, request.body);
      return { success: true as const, data: result.data };
    },
    {
      sessionAuth: true,
      params: AgentSiteAppFileParamsSchema,
      response: {
        200: WebOkSchema(z.unknown().describe("agent-sites 上游返回体。")),
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Agent Sites"],
        summary: "上传前端静态文件",
        description: "单文件上传到 agent-sites。owner/admin 可操作。",
      },
    },
  )

  .post(
    "/apps/:id/files/bundle",
    async ({ params, request, store, status }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return status(403, buildError("forbidden", "无权限上传文件"));
      }
      const result = await uploadRemoteBundle(row.remoteAppId, request.body);
      return { success: true as const, data: result.data };
    },
    {
      sessionAuth: true,
      params: AgentSiteAppIdParamsSchema,
      response: {
        200: WebOkSchema(z.unknown().describe("agent-sites 上游返回体。")),
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Agent Sites"],
        summary: "批量上传前端文件",
        description: "gzip tar 批量上传到 agent-sites。owner/admin 可操作。",
      },
    },
  )

  // ── L1: Custom App 部署 ──────────────────────────────
  // 仅 type=custom 的 app 支持部署。透传 gzip tar.gz body 到 agent-sites 平台。
  // 平台做解压、TCP 探活（10s）、双槽位切换。RCS 拿到 entry_file/slot 写入 DB。
  .post(
    "/apps/:id/deploy",
    async ({ params, request, store, status }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      if (!canWrite(row, authCtx.userId, authCtx.role)) {
        return status(403, buildError("forbidden", "无权限部署此 app"));
      }
      // 类型校验：只有 custom 类型支持部署（pocketbase 由平台托管，无需部署代码）
      if (row.appType !== "custom") {
        return status(
          400,
          buildError("bad_request", `App ${row.remoteAppId} 不是 custom 类型，无法部署（当前: ${row.appType}）`),
        );
      }
      // 透传 gzip body 到平台，平台做解压 + 探活 + 切换
      const remote = await deployCustomApp(row.remoteAppId, request.body);
      // 平台返回的 slot 是 "a" | "b"，DB 与响应 schema 均要求此字面量类型
      const slot = remote.data.slot as "a" | "b";
      // 写入 RCS DB 记录部署元数据（entry_file / slot / deployed_at）
      const now = new Date();
      await agentSiteAppRepo.update(params.id, {
        entryFile: remote.data.entry_file,
        activeSlot: slot,
        deployedAt: now,
      });
      return {
        success: true as const,
        data: {
          files: remote.data.files,
          totalBytes: remote.data.total_bytes,
          entryFile: remote.data.entry_file,
          slot,
          deployedAt: Math.floor(now.getTime() / 1000),
        },
      };
    },
    {
      sessionAuth: true,
      params: AgentSiteAppIdParamsSchema,
      response: {
        200: AgentSiteDeployResponseSchema,
        400: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Agent Sites"],
        summary: "部署 custom app（gzip tar.gz）",
        description:
          "上传 Deno 应用 gzip tar.gz 包到 custom 类型 app。平台解压、TCP 探活（10s）、双槽位热切换。pocketbase 类型返 400。owner/admin 可操作。",
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
      const ordered = siteAppIds
        .map((id) => apps.find((a) => a.id === id))
        .filter((a): a is AgentSiteAppRow => !!a && canRead(a, authCtx.userId));
      return { success: true as const, data: ordered.map(toResponse) };
    },
    {
      sessionAuth: true,
      params: AgentSiteAgentConfigParamsSchema,
      response: AgentSiteAppListResponseSchema,
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
    async ({ params, store, status }) => {
      const authCtx = store.authContext!;
      const agentConfig = await getAgentConfigById(params.agentConfigId, authCtx.organizationId);
      if (!agentConfig) {
        return status(404, buildError("not_found", "Agent 配置不存在"));
      }
      // siteAppId 可能是 UUID（从 MountSiteDialog 传入）或 remoteAppId（从卡片
      // artifacts:select-site 事件自动挂载传入）。按格式判断走不同查找方法。
      const siteApp = await resolveSiteApp(params.siteAppId);
      if (!siteApp || siteApp.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "Site 不存在"));
      }
      // 永远用 siteApp.id（UUID）写入绑定表，保证 listByIds 的 JOIN 正确
      await addAgentSiteApp(params.agentConfigId, siteApp.id);
      return { success: true as const, data: null };
    },
    {
      sessionAuth: true,
      params: AgentSiteBindingParamsSchema,
      response: {
        200: AgentSiteAppOkResponseSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Agent Sites"],
        summary: "挂载单个 site 到 agent",
        description: "单点绑定，PK 联合唯一保证幂等。chat 右侧 Sites tab 的 + 按钮调用。",
      },
    },
  )

  .delete(
    "/agent-configs/:agentConfigId/sites/:siteAppId",
    async ({ params, store, status }) => {
      const authCtx = store.authContext!;
      const agentConfig = await getAgentConfigById(params.agentConfigId, authCtx.organizationId);
      if (!agentConfig) {
        return status(404, buildError("not_found", "Agent 配置不存在"));
      }
      const siteApp = await resolveSiteApp(params.siteAppId);
      if (!siteApp || siteApp.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "Site 不存在"));
      }
      await removeAgentSiteApp(params.agentConfigId, siteApp.id);
      return { success: true as const, data: null };
    },
    {
      sessionAuth: true,
      params: AgentSiteBindingParamsSchema,
      response: {
        200: AgentSiteAppOkResponseSchema,
        404: WebErrSchema,
      },
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
    async ({ params, request, store, status }) => {
      const authCtx = store.authContext!;
      const row = await agentSiteAppRepo.getById(params.id);
      if (!row || row.organizationId !== authCtx.organizationId) {
        return status(404, buildError("not_found", "App 不存在"));
      }
      // custom 类型没有 PocketBase，L2 PB 透传无意义——明确拒绝避免被上游 404 误导
      if (row.appType === "custom") {
        return status(
          400,
          buildError(
            "bad_request",
            `Custom 类型 app ${row.remoteAppId} 不支持 PocketBase API，请走业务前端 /${row.remoteAppId}/* 或 L1 deploy 接口`,
          ),
        );
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
      params: AgentSiteAppIdParamsSchema,
      detail: {
        hide: true,
        tags: ["Agent Sites"],
        summary: "透传 PB Admin API",
        description: "注入 platform token 后透传到 agent-sites PB API。任何 org 成员可调。",
      },
    },
  );

export default app;
