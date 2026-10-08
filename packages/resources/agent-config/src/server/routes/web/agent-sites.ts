import type { ActorContext } from "@fenix/platform-sdk";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { getAgentConfigModule } from "../../runtime";
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
import type { WebAgentConfigRouteDependencies } from "../dependencies";
import { createAgentSiteAssociationRoutes } from "./agent-site-association-routes";
import { FORBIDDEN_MESSAGE, runSiteAction, toViewResponse } from "./agent-site-route-support";

/**
 * `/web/agent-sites` 协议层（站点 App CRUD / Token / 文件上传 / 部署）。
 *
 * 改为工厂（CE 阶段 2 任务 1.3）：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state`
 * 是实例作用域的，父实例无法向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`。
 *
 * 本文件只做协议适配：主体一律取 `store.actor`（平台 `ActorContext`）并原样交给站点 Facade——组织、
 * 用户、可见范围、写权限与创建规则都由 Facade 与授权模块产出，这里不解释角色或 `visibility`；
 * 失败经 `runSiteAction` 映射为 `/web` 状态码与文案。无法定位组织资源的主体由 Facade 抛
 * `no_organization`，映射为 401（迁移前用 `store.authContext!` 断言后直接取字段，无组织上下文会以
 * TypeError 变成 500）。
 */
export function createWebAgentSitesRoutes(deps: WebAgentConfigRouteDependencies) {
  const app = new Elysia({ name: "web-agent-sites", prefix: "/agent-sites" })
    .use(deps.authGuardPlugin)

    // ── L1: App CRUD ────────────────────────────────────

    .get(
      "/apps",
      async ({ store, status }) => {
        const actor = store.actor as ActorContext | null;
        return runSiteAction(status, async () => {
          const items = await getAgentConfigModule().siteFacade.list(actor);
          return { success: true as const, data: items.map(toViewResponse) };
        });
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
          description: "返回当前组织下当前用户可见的 app。",
        },
      },
    )

    .get(
      "/apps/:id",
      async ({ params, store, status }) => {
        const actor = store.actor as ActorContext | null;
        return runSiteAction(status, async () => {
          const item = await getAgentConfigModule().siteFacade.getById(actor, params.id);
          return { success: true as const, data: toViewResponse(item) };
        });
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
        const actor = store.actor as ActorContext | null;
        return runSiteAction(status, async () => {
          const item = await getAgentConfigModule().siteFacade.getByRemoteAppId(actor, params.remoteAppId);
          return { success: true as const, data: toViewResponse(item) };
        });
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
        const actor = store.actor as ActorContext | null;
        const request = body as CreateAgentSiteAppRequest;
        return runSiteAction(status, async () => {
          // 远端 app 创建、token 申请与本地持久化都在 Facade 里编排（顺序与回滚语义见 Facade）。
          const item = await getAgentConfigModule().siteFacade.create(actor, {
            name: request.name,
            ...(request.description === undefined ? {} : { description: request.description }),
            visibility: request.visibility,
            type: request.type,
            ...(request.agentConfigId === undefined ? {} : { agentConfigId: request.agentConfigId }),
          });
          return { success: true as const, data: toViewResponse(item) };
        });
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
        const actor = store.actor as ActorContext | null;
        const request = body as UpdateAgentSiteAppRequest;
        return runSiteAction(
          status,
          async () => {
            const item = await getAgentConfigModule().siteFacade.update(actor, params.id, {
              ...(request.name === undefined ? {} : { name: request.name }),
              ...(request.description === undefined ? {} : { description: request.description }),
              ...(request.visibility === undefined ? {} : { visibility: request.visibility }),
            });
            return { success: true as const, data: toViewResponse(item) };
          },
          { forbidden: FORBIDDEN_MESSAGE.update },
        );
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
        const actor = store.actor as ActorContext | null;
        return runSiteAction(
          status,
          async () => {
            await getAgentConfigModule().siteFacade.remove(actor, params.id);
            return { success: true as const, data: null };
          },
          { forbidden: FORBIDDEN_MESSAGE.delete },
        );
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
        const actor = store.actor as ActorContext | null;
        return runSiteAction(
          status,
          async () => {
            await getAgentConfigModule().siteFacade.rotateToken(actor, params.id);
            return { success: true as const, data: null };
          },
          { forbidden: FORBIDDEN_MESSAGE.rotateToken },
        );
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
        const actor = store.actor as ActorContext | null;
        return runSiteAction(
          status,
          async () => {
            const data = await getAgentConfigModule().siteFacade.uploadFile(
              actor,
              params.id,
              params.path,
              request.body as ReadableStream<Uint8Array> | null,
            );
            return { success: true as const, data };
          },
          { forbidden: FORBIDDEN_MESSAGE.uploadFile },
        );
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
        const actor = store.actor as ActorContext | null;
        return runSiteAction(
          status,
          async () => {
            const data = await getAgentConfigModule().siteFacade.uploadBundle(
              actor,
              params.id,
              request.body as ReadableStream<Uint8Array> | null,
            );
            return { success: true as const, data };
          },
          { forbidden: FORBIDDEN_MESSAGE.uploadFile },
        );
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
        const actor = store.actor as ActorContext | null;
        return runSiteAction(
          status,
          async () => {
            const result = await getAgentConfigModule().siteFacade.deploy(
              actor,
              params.id,
              request.body as ReadableStream<Uint8Array> | null,
            );
            return {
              success: true as const,
              data: {
                files: result.files,
                totalBytes: result.totalBytes,
                entryFile: result.entryFile,
                slot: result.slot,
                deployedAt: Math.floor(result.deployedAt.getTime() / 1000),
              },
            };
          },
          { forbidden: FORBIDDEN_MESSAGE.deploy },
        );
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
