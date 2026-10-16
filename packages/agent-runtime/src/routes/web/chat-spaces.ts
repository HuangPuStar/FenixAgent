/**
 * 控制台会话分组路由工厂：`/web/chat-spaces/**`。
 *
 * 归属：分组是持久实例的附属偏好数据，实例与环境的归属规则都在本包（`facades/chat-space-facade`
 * 收敛整条授权链），因此路由落在本包；宿主只保留注入守卫后的挂载。
 *
 * 本文件只有协议适配：路径/查询/请求体校验（Elysia model）、认证上下文提取、视图投影与
 * 「`AppError.statusCode` → 响应」映射。组织与用户的归属判断、分组规则都不在这里。
 *
 * 错误响应形状照抄 `routes/web/instances.ts`（`{ success: false, error: { code, message } }`）；
 * 错误码与文案集中在 `server/services/chat-space-errors.ts` 声明（小写口径，与控制面一致）。
 *
 * 守卫由宿主注入（与 `/web/instances`、`/web/sessions/*` 同因）：Elysia 的 `macro` / `state` 是实例
 * 作用域的，包内自建一份会让同一进程出现两套互不可见的认证状态。
 */

import { AppError, WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { chatSpaceFacade } from "../../facades/chat-space-facade";
import {
  ChatSpaceCreateRequestSchema,
  ChatSpaceInfoSchema,
  ChatSpaceInstanceQuerySchema,
  ChatSpaceListResponseSchema,
  ChatSpaceMutationResponseSchema,
  ChatSpaceRemovalResponseSchema,
  ChatSpaceRenameRequestSchema,
} from "../../schemas/chat-space.schema";
import type { ChatSpaceRecord } from "../../server/repositories/chat-space";
import type { AgentRuntimeAuthDependencies } from "../dependencies";

/** 领域记录 → 协议视图：只投影 schema 声明过的字段（落盘的线上形状即 schema 本身）。 */
function toChatSpaceView(space: ChatSpaceRecord) {
  return {
    id: space.id,
    instanceUid: space.instanceUid,
    name: space.name,
    sessionIds: space.sessionIds,
    createdAt: space.createdAt.toISOString(),
    updatedAt: space.updatedAt.toISOString(),
  };
}

/**
 * 从认证上下文取门面入参。
 *
 * 组织或用户缺失（没有 active organization 的会话）时无法判定归属，一律拒绝（与 `routes/web/control.ts`
 * 同口径）；返回空值而不是抛错，让调用点显式映射成响应。
 */
function readAccessContext(store: {
  user?: { id?: string } | null;
  authContext?: { organizationId?: string } | null;
}): { organizationId: string; userId: string } | null {
  const userId = store.user?.id;
  const organizationId = store.authContext?.organizationId;
  if (!userId || !organizationId) return null;
  return { organizationId, userId };
}

/** 认证上下文不完整时的拒绝：此时还没有具体资源可谈，文案与门面的 403 一致。 */
function unauthenticatedResponse(error: (code: number, body: unknown) => unknown) {
  return error(403, { success: false, error: { code: "forbidden", message: "Not authenticated" } });
}

/** `AppError` → 控制面错误响应；非 `AppError` 原样上抛（由宿主错误处理器按 500 记录诊断）。 */
function mapThrownError(error_: unknown, error: (code: number, body: unknown) => unknown): unknown {
  if (error_ instanceof AppError) {
    return error(error_.statusCode, { success: false, error: { code: error_.code, message: error_.message } });
  }
  throw error_;
}

/**
 * 构造 `/web/chat-spaces/**` 路由。
 *
 * 五个动作共用同一条授权链（实例属于当前用户、其环境属于当前组织）：授权在门面内完成，本文件只负责把
 * 入参组装好、把异常与记录映射成响应。除创建（实例在请求体里）外，四个动作一律在 query 上带 `instanceUid`：
 * 它是权威作用域——路径里的分组（若有）只在该实例内解析（见门面 `#scopeForSpace`），移出没有分组路径参数，
 * 按 scope 摘除（见门面 `removeSession`）。
 */
export function createWebChatSpacesRoutes(deps: AgentRuntimeAuthDependencies) {
  const app = new Elysia({ name: "web-chat-spaces" }).use(deps.authGuardPlugin).model({
    "chat-space-info": ChatSpaceInfoSchema,
    "chat-space-instance-query": ChatSpaceInstanceQuerySchema,
    "chat-space-list-response": ChatSpaceListResponseSchema,
    "chat-space-create-request": ChatSpaceCreateRequestSchema,
    "chat-space-mutation-response": ChatSpaceMutationResponseSchema,
    "chat-space-removal-response": ChatSpaceRemovalResponseSchema,
    "chat-space-rename-request": ChatSpaceRenameRequestSchema,
  });

  /** GET /web/chat-spaces — 列出当前用户在某实例下的分组；未归属的会话不在此列表中（前端落「默认」）。 */
  app.get(
    "/chat-spaces",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, query, error }: any) => {
      const access = readAccessContext(store);
      if (!access) return unauthenticatedResponse(error);
      try {
        const spaces = await chatSpaceFacade.listSpaces({
          ...access,
          instanceUid: (query as { instanceUid: string }).instanceUid,
        });
        return { success: true as const, data: { spaces: spaces.map(toChatSpaceView) } };
      } catch (err: unknown) {
        return mapThrownError(err, error);
      }
    },
    {
      sessionAuth: true,
      query: "chat-space-instance-query",
      response: {
        200: "chat-space-list-response",
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Chat Spaces"],
        summary: "列出会话分组",
        description:
          "返回当前用户在该持久实例下的全部分组；实例不属于当前用户（404）或其所绑环境不在当前组织（403）时拒绝。",
      },
    },
  );

  /** POST /web/chat-spaces — 新建分组；同 scope 重名返回 409。 */
  app.post(
    "/chat-spaces",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, body, error }: any) => {
      const access = readAccessContext(store);
      if (!access) return unauthenticatedResponse(error);
      const input = body as { instanceUid: string; name: string };
      try {
        const space = await chatSpaceFacade.createSpace({ ...access, ...input });
        return { success: true as const, data: { space: toChatSpaceView(space) } };
      } catch (err: unknown) {
        return mapThrownError(err, error);
      }
    },
    {
      sessionAuth: true,
      body: "chat-space-create-request",
      response: {
        200: "chat-space-mutation-response",
        400: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
        409: WebErrSchema,
      },
      detail: {
        tags: ["Chat Spaces"],
        summary: "新建会话分组",
        description: "在当前用户于该实例下创建分组；名称 trim 后需为 1-100 字符，同实例同属主下重名返回 409。",
      },
    },
  );

  /** PATCH /web/chat-spaces/:id — 重命名分组；分组 id 在 `instanceUid` 指定的实例内解析。 */
  app.patch(
    "/chat-spaces/:id",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, query, body, error }: any) => {
      const access = readAccessContext(store);
      if (!access) return unauthenticatedResponse(error);
      const input = body as { name: string };
      try {
        const space = await chatSpaceFacade.renameSpace({
          ...access,
          instanceUid: (query as { instanceUid: string }).instanceUid,
          spaceId: (params as { id: string }).id,
          name: input.name,
        });
        return { success: true as const, data: { space: toChatSpaceView(space) } };
      } catch (err: unknown) {
        return mapThrownError(err, error);
      }
    },
    {
      sessionAuth: true,
      query: "chat-space-instance-query",
      body: "chat-space-rename-request",
      response: {
        200: "chat-space-mutation-response",
        400: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
        409: WebErrSchema,
      },
      detail: {
        tags: ["Chat Spaces"],
        summary: "重命名会话分组",
        description:
          "在 `instanceUid` 指定的实例内重命名分组；名称 trim 后需为 1-100 字符，同实例同属主下重名返回 409。",
      },
    },
  );

  /**
   * PUT /web/chat-spaces/:id/sessions/:sessionId — 把会话移入分组。
   *
   * 归属唯一（一个会话至多在一个分组）由仓储在同一事务内的原子摘除 + 追加保证，本层不做补偿逻辑。
   */
  app.put(
    "/chat-spaces/:id/sessions/:sessionId",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, query, error }: any) => {
      const access = readAccessContext(store);
      if (!access) return unauthenticatedResponse(error);
      const path = params as { id: string; sessionId: string };
      try {
        const space = await chatSpaceFacade.assignSession({
          ...access,
          instanceUid: (query as { instanceUid: string }).instanceUid,
          spaceId: path.id,
          sessionId: path.sessionId,
        });
        return { success: true as const, data: { space: toChatSpaceView(space) } };
      } catch (err: unknown) {
        return mapThrownError(err, error);
      }
    },
    {
      sessionAuth: true,
      query: "chat-space-instance-query",
      response: {
        200: "chat-space-mutation-response",
        400: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Chat Spaces"],
        summary: "移入会话分组",
        description: "在 `instanceUid` 指定的实例内把会话归入分组；该会话会先被原子移出原分组，因此至多属于一个分组。",
      },
    },
  );

  /**
   * DELETE /web/chat-spaces/sessions/:sessionId — 取消会话归属（从该实例的所有分组摘除，幂等）。
   *
   * 路径里没有分组 id：调用方表达的是「不再属于任何分组」，让服务端按 scope 决定摘除范围，
   * 调用方就不必先反查会话当前属于哪个分组（那份反查在本地快照滞后于在途写入时会指到旧分组，
   * 摘除落空而归属留存）。会话本就不在任何分组时仍返回 200，`data.space` 为 `null`。
   */
  app.delete(
    "/chat-spaces/sessions/:sessionId",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
    async ({ store, params, query, error }: any) => {
      const access = readAccessContext(store);
      if (!access) return unauthenticatedResponse(error);
      try {
        const space = await chatSpaceFacade.removeSession({
          ...access,
          instanceUid: (query as { instanceUid: string }).instanceUid,
          sessionId: (params as { sessionId: string }).sessionId,
        });
        return { success: true as const, data: { space: space ? toChatSpaceView(space) : null } };
      } catch (err: unknown) {
        return mapThrownError(err, error);
      }
    },
    {
      sessionAuth: true,
      query: "chat-space-instance-query",
      response: {
        200: "chat-space-removal-response",
        400: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["Chat Spaces"],
        summary: "移出会话分组",
        description:
          "在 `instanceUid` 指定的实例内取消会话归属（从该实例的所有分组摘除）；会话本就不在任何分组时同样返回成功，`space` 为 null（幂等）。",
      },
    },
  );

  return app;
}
