import type { ActorContext } from "@fenix/platform-sdk";
import { WebErrSchema } from "@fenix/platform-sdk";
import { agentConfigSiteApp } from "@server/db/schema";
import { eq } from "drizzle-orm";
import Elysia from "elysia";
import { getAgentConfigDatabase } from "../../db";
import type { AgentSiteAppRow } from "../../repositories/agent-site-app";
import { agentSiteAppRepo } from "../../repositories/agent-site-app";
import {
  AgentSiteAgentConfigParamsSchema,
  AgentSiteAppIdParamsSchema,
  AgentSiteAppListResponseSchema,
  AgentSiteAppOkResponseSchema,
  AgentSiteBindingParamsSchema,
} from "../../schemas/agent-site.schema";
import { proxyToAgentSites } from "../../services/agent-sites";
import { addAgentSiteApp, removeAgentSiteApp } from "../../services/config/agent-config-site-app";
import { getAgentConfigById } from "../../system-entries";
import type { WebAgentConfigRouteDependencies } from "../dependencies";
import {
  attachCreatorNames,
  buildError,
  canRead,
  resolveSiteActor,
  resolveSiteApp,
  toResponse,
} from "./agent-site-route-support";

/**
 * AgentConfig ↔ SiteApp 绑定与 PocketBase 透传路由。
 *
 * 改为工厂（CE 阶段 2 任务 1.3）：由 `createWebAgentSitesRoutes` 注入同一份依赖后 `.use()`，守卫实例
 * 与宿主认证解析保持一致；主体经 `resolveSiteActor` 从 `store.actor` 投影。
 */
export function createAgentSiteAssociationRoutes(deps: WebAgentConfigRouteDependencies) {
  return (
    new Elysia({ name: "web-agent-sites-associations" })
      .use(deps.authGuardPlugin)
      // ── L1.5: AgentConfig ↔ SiteApp 绑定查询 ───────────
      // chat 右侧 ArtifactsPanel 通过 agentConfigId 拉取绑定的 sites 详情，
      // 用于顶部 Files / Site1 / Site2 tab 切换。返回顺序按绑定 createdAt 升序，
      // 与 AgentFormDialog 中勾选顺序一致，确保 UI 展示稳定。

      .get(
        "/agent-configs/:agentConfigId/sites",
        async ({ params, store, status }) => {
          const actor = resolveSiteActor(store.actor as ActorContext | null);
          if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
          const siteAppIdsRows = await getAgentConfigDatabase()
            .select({ siteAppId: agentConfigSiteApp.siteAppId })
            .from(agentConfigSiteApp)
            .where(eq(agentConfigSiteApp.agentConfigId, params.agentConfigId));
          const siteAppIds = siteAppIdsRows.map((r) => r.siteAppId);
          if (siteAppIds.length === 0) {
            return { success: true as const, data: [] };
          }
          const apps = await agentSiteAppRepo.listByIds(siteAppIds, actor.organizationId);
          // 保持绑定顺序（与勾选顺序一致，UI 展示稳定）
          const ordered = siteAppIds
            .map((id) => apps.find((a) => a.id === id))
            .filter((a): a is AgentSiteAppRow => !!a && canRead(a, actor.userId));
          const items = ordered.map(toResponse);
          await attachCreatorNames(items);
          return { success: true as const, data: items };
        },
        {
          sessionAuth: true,
          params: AgentSiteAgentConfigParamsSchema,
          response: {
            200: AgentSiteAppListResponseSchema,
            401: WebErrSchema,
          },
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
          const actor = resolveSiteActor(store.actor as ActorContext | null);
          if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
          const agentConfig = await getAgentConfigById(params.agentConfigId, actor.organizationId);
          if (!agentConfig) {
            return status(404, buildError("not_found", "Agent 配置不存在"));
          }
          // siteAppId 可能是 UUID（从 MountSiteDialog 传入）或 remoteAppId（从卡片
          // artifacts:select-site 事件自动挂载传入）。按格式判断走不同查找方法。
          const siteApp = await resolveSiteApp(params.siteAppId);
          if (!siteApp || siteApp.organizationId !== actor.organizationId) {
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
            401: WebErrSchema,
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
          const actor = resolveSiteActor(store.actor as ActorContext | null);
          if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
          const agentConfig = await getAgentConfigById(params.agentConfigId, actor.organizationId);
          if (!agentConfig) {
            return status(404, buildError("not_found", "Agent 配置不存在"));
          }
          const siteApp = await resolveSiteApp(params.siteAppId);
          if (!siteApp || siteApp.organizationId !== actor.organizationId) {
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
            401: WebErrSchema,
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
          const actor = resolveSiteActor(store.actor as ActorContext | null);
          if (!actor) return status(401, buildError("unauthorized", "请求缺少组织上下文"));
          const row = await agentSiteAppRepo.getById(params.id);
          if (!row || row.organizationId !== actor.organizationId) {
            return status(404, buildError("not_found", "App 不存在"));
          }
          // custom 类型没有 PocketBase，L2 PB 透传无意义——明确拒绝避免被上游 404 误导
          if (row.appType === "custom") {
            return status(
              400,
              buildError(
                "bad_request",
                `Custom 类型 app ${row.remoteAppId} 不支持 PocketBase API，请走业务前端 /web/site/deploy/${row.remoteAppId}/* 或 L1 deploy 接口`,
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
      )
  );
}
