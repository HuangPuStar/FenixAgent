import type { ActorContext } from "@fenix/platform-sdk";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { agentSiteAppRepo } from "../../repositories/agent-site-app";
import {
  AgentSiteAppDetailResponseSchema,
  AgentSiteAppFileParamsSchema,
  AgentSiteAppIdParamsSchema,
  AgentSiteAppListResponseSchema,
  AgentSiteAppOkResponseSchema,
  AgentSiteDeployResponseSchema,
  AgentSiteRemoteAppParamsSchema,
  type CreateAgentSiteAppRequest,
  CreateAgentSiteAppRequestSchema,
  type UpdateAgentSiteAppRequest,
  UpdateAgentSiteAppRequestSchema,
} from "../../schemas/agent-site.schema";
import {
  createRemoteApp,
  deleteRemoteApp,
  deployCustomApp,
  issuePlatformToken,
  revokePlatformToken,
  uploadRemoteBundle,
  uploadRemoteFile,
} from "../../services/agent-sites";
import { invalidateAppCache } from "../agent-sites-proxy";
import type { WebAgentConfigRouteDependencies } from "../dependencies";
import { createAgentSiteAssociationRoutes } from "./agent-site-association-routes";
import {
  attachCreatorNames,
  buildError,
  canRead,
  canWrite,
  resolveSiteActor,
  toResponse,
} from "./agent-site-route-support";

/**
 * `/web/agent-sites` 协议层（站点 App CRUD / Token / 文件上传 / 部署）。
 *
 * 改为工厂（CE 阶段 2 任务 1.3）：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state`
 * 是实例作用域的，父实例无法向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`。
 *
 * 主体一律取 `store.actor`（平台 `ActorContext`）并经 `resolveSiteActor` 投影：组织、用户与当前组织
 * 角色都从可信主体解析，不再读宿主 `AuthContext` 的字段。无法解析主体时返回 401（迁移前用
 * `store.authContext!` 断言后直接取字段，无组织上下文会以 TypeError 变成 500）。
 */
export function createWebAgentSitesRoutes(deps: WebAgentConfigRouteDependencies) {
  const app = new Elysia({ name: "web-agent-sites", prefix: "/agent-sites" })
    .use(deps.authGuardPlugin)

    // ── L1: App CRUD ────────────────────────────────────

    .get(
      "/apps",
      async ({ store, status }) => {
        const actor = resolveSiteActor(store.actor as ActorContext | null);
        if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
        const rows = await agentSiteAppRepo.listByOrg(actor.organizationId);
        const visible = rows.filter((r) => canRead(r, actor.userId));
        const items = visible.map(toResponse);
        await attachCreatorNames(items);
        return { success: true as const, data: items };
      },
      {
        sessionAuth: true,
        response: {
          200: AgentSiteAppListResponseSchema,
          401: WebErrSchema,
        },
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
        const actor = resolveSiteActor(store.actor as ActorContext | null);
        if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
        const row = await agentSiteAppRepo.getById(params.id);
        if (!row || row.organizationId !== actor.organizationId || !canRead(row, actor.userId)) {
          return status(404, buildError("not_found", "App 不存在"));
        }
        const item = toResponse(row);
        await attachCreatorNames([item]);
        return { success: true as const, data: item };
      },
      {
        sessionAuth: true,
        params: AgentSiteAppIdParamsSchema,
        response: {
          200: AgentSiteAppDetailResponseSchema,
          401: WebErrSchema,
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
        const actor = resolveSiteActor(store.actor as ActorContext | null);
        if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
        const row = await agentSiteAppRepo.getByRemoteAppId(params.remoteAppId);
        if (!row || row.organizationId !== actor.organizationId || !canRead(row, actor.userId)) {
          return status(404, buildError("not_found", "App 不存在"));
        }
        const item = toResponse(row);
        await attachCreatorNames([item]);
        return { success: true as const, data: item };
      },
      {
        sessionAuth: true,
        params: AgentSiteRemoteAppParamsSchema,
        response: {
          200: AgentSiteAppDetailResponseSchema,
          401: WebErrSchema,
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
      async ({ store, body, status }) => {
        const actor = resolveSiteActor(store.actor as ActorContext | null);
        if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
        const b = body as CreateAgentSiteAppRequest;

        // 1. 在 agent-sites 创建远程 app（透传 type，默认 pocketbase）
        const remote = await createRemoteApp(b.name, b.type);

        // 2. 申请 platform token（custom 类型其实用不到 token——没有 PB，
        //    但保留以保持 RCS DB schema 一致；后续如需迁移回 pocketbase 也无缝）
        const token = await issuePlatformToken(remote.id);

        // 3. 写入 RCS DB
        const row = await agentSiteAppRepo.create({
          organizationId: actor.organizationId,
          userId: actor.userId,
          remoteAppId: remote.id,
          name: remote.name,
          description: b.description,
          platformToken: token.token,
          platformTokenId: token.token_id,
          visibility: (b.visibility as "private" | "org" | "authenticated" | "public") ?? "private",
          appType: b.type,
          createdByAgentConfigId: b.agentConfigId ?? null,
        });

        const item = toResponse(row);
        await attachCreatorNames([item]);
        return { success: true as const, data: item };
      },
      {
        sessionAuth: true,
        body: CreateAgentSiteAppRequestSchema,
        response: {
          200: AgentSiteAppDetailResponseSchema,
          401: WebErrSchema,
        },
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
        const actor = resolveSiteActor(store.actor as ActorContext | null);
        if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
        const b = body as UpdateAgentSiteAppRequest;
        const row = await agentSiteAppRepo.getById(params.id);
        if (!row || row.organizationId !== actor.organizationId) {
          return status(404, buildError("not_found", "App 不存在"));
        }
        if (!canWrite(row, actor.userId, actor.role)) {
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
        const item = toResponse(updated!);
        await attachCreatorNames([item]);
        return { success: true as const, data: item };
      },
      {
        sessionAuth: true,
        params: AgentSiteAppIdParamsSchema,
        body: UpdateAgentSiteAppRequestSchema,
        response: {
          200: AgentSiteAppDetailResponseSchema,
          401: WebErrSchema,
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
        const actor = resolveSiteActor(store.actor as ActorContext | null);
        if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
        const row = await agentSiteAppRepo.getById(params.id);
        if (!row || row.organizationId !== actor.organizationId) {
          return status(404, buildError("not_found", "App 不存在"));
        }
        if (!canWrite(row, actor.userId, actor.role)) {
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
          401: WebErrSchema,
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
        const actor = resolveSiteActor(store.actor as ActorContext | null);
        if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
        const row = await agentSiteAppRepo.getById(params.id);
        if (!row || row.organizationId !== actor.organizationId) {
          return status(404, buildError("not_found", "App 不存在"));
        }
        if (!canWrite(row, actor.userId, actor.role)) {
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
          401: WebErrSchema,
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
        const actor = resolveSiteActor(store.actor as ActorContext | null);
        if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
        const row = await agentSiteAppRepo.getById(params.id);
        if (!row || row.organizationId !== actor.organizationId) {
          return status(404, buildError("not_found", "App 不存在"));
        }
        if (!canWrite(row, actor.userId, actor.role)) {
          return status(403, buildError("forbidden", "无权限上传文件"));
        }
        // biome-ignore lint/suspicious/noExplicitAny: 透传 raw binary body 到上游 agent-sites 平台，不匹配 Elysia schema 类型
        const result = await uploadRemoteFile(row.remoteAppId, params.path, request.body as any);
        return { success: true as const, data: result.data };
      },
      {
        sessionAuth: true,
        params: AgentSiteAppFileParamsSchema,
        response: {
          200: WebOkSchema(z.unknown().describe("agent-sites 上游返回体。")),
          401: WebErrSchema,
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
        const actor = resolveSiteActor(store.actor as ActorContext | null);
        if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
        const row = await agentSiteAppRepo.getById(params.id);
        if (!row || row.organizationId !== actor.organizationId) {
          return status(404, buildError("not_found", "App 不存在"));
        }
        if (!canWrite(row, actor.userId, actor.role)) {
          return status(403, buildError("forbidden", "无权限上传文件"));
        }
        // biome-ignore lint/suspicious/noExplicitAny: 透传 gzip tar raw body 到上游 agent-sites 平台
        const result = await uploadRemoteBundle(row.remoteAppId, request.body as any);
        return { success: true as const, data: result.data };
      },
      {
        sessionAuth: true,
        params: AgentSiteAppIdParamsSchema,
        response: {
          200: WebOkSchema(z.unknown().describe("agent-sites 上游返回体。")),
          401: WebErrSchema,
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
        const actor = resolveSiteActor(store.actor as ActorContext | null);
        if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
        const row = await agentSiteAppRepo.getById(params.id);
        if (!row || row.organizationId !== actor.organizationId) {
          return status(404, buildError("not_found", "App 不存在"));
        }
        if (!canWrite(row, actor.userId, actor.role)) {
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
        // biome-ignore lint/suspicious/noExplicitAny: 透传 gzip tar.gz raw body 到上游 agent-sites 平台部署
        const remote = await deployCustomApp(row.remoteAppId, request.body as any);
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
          401: WebErrSchema,
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

    .use(createAgentSiteAssociationRoutes(deps));

  return app;
}
