import type { ActorContext } from "@fenix/platform-sdk";
import { WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import type { PocketBaseProxyTarget } from "../../facades/agent-site-app-facade";
import { getAgentConfigModule } from "../../runtime";
import {
  AgentSiteAgentConfigParamsSchema,
  AgentSiteAppIdParamsSchema,
  AgentSiteAppListResponseSchema,
  AgentSiteAppOkResponseSchema,
  AgentSiteBindingParamsSchema,
} from "../../schemas/agent-site.schema";
import { proxyToAgentSites } from "../../services/agent-sites";
import type { WebAgentConfigRouteDependencies } from "../dependencies";
import { runSiteAction, toSiteFailure, toViewResponse } from "./agent-site-route-support";

/**
 * AgentConfig ↔ SiteApp 绑定与 PocketBase 透传路由。
 *
 * 改为工厂（CE 阶段 2 任务 1.3）：由 `createWebAgentSitesRoutes` 注入同一份依赖后 `.use()`，守卫实例
 * 与宿主认证解析保持一致；主体一律取 `store.actor` 并原样交给站点 Facade——组织校验（Agent 与站点都
 * 必须在当前组织内）、绑定表读写与写权限判定都在 Facade 里完成，本文件只做协议映射。
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
          const actor = store.actor as ActorContext | null;
          return runSiteAction(status, async () => {
            const items = await getAgentConfigModule().siteFacade.listBoundApps(actor, params.agentConfigId);
            return { success: true as const, data: items.map(toViewResponse) };
          });
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
          const actor = store.actor as ActorContext | null;
          return runSiteAction(
            status,
            async () => {
              await getAgentConfigModule().siteFacade.bind(actor, params.agentConfigId, params.siteAppId);
              return { success: true as const, data: null };
            },
            { site_not_found: "Site 不存在" },
          );
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
          const actor = store.actor as ActorContext | null;
          return runSiteAction(
            status,
            async () => {
              await getAgentConfigModule().siteFacade.unbind(actor, params.agentConfigId, params.siteAppId);
              return { success: true as const, data: null };
            },
            { site_not_found: "Site 不存在" },
          );
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
          const actor = store.actor as ActorContext | null;
          let target: PocketBaseProxyTarget;
          try {
            target = await getAgentConfigModule().siteFacade.getPocketBaseProxyTarget(actor, params.id);
          } catch (error) {
            const failure = toSiteFailure(error);
            return status(failure.status, failure.body);
          }
          // 提取 prefix 之后的相对路径，拼回 /api/ 前缀
          const prefix = `/web/agent-sites/apps/${params.id}/api/`;
          const url = new URL(request.url);
          const relative = url.pathname.substring(url.pathname.indexOf(prefix) + prefix.length);
          const apiPath = `/api/${relative}`;
          return proxyToAgentSites(target.remoteAppId, apiPath, request, {
            Authorization: `Bearer ${target.platformToken}`,
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
