/**
 * chat-spaces.ts — 会话分组（Chat Space）API 模块
 *
 * 分组是持久 Agent Instance 的附属偏好数据（后端 `chat_space` 表，控制面路由 `/web/chat-spaces/**` 由本包
 * `src/routes/web/chat-spaces.ts` 提供），因此浏览器侧 client 与实例 client 同处本包的 `web/api/`，经
 * `@fenix/agent-runtime/web/api/chat-spaces` 暴露窄口。
 *
 * 只做协议适配：路径、方法、请求体与键名归一。授权与领域规则全在后端（实例归属、环境组织、命名唯一性），
 * 客户端不复制一份判据。
 *
 * 键名归一的边界：请求层的 `camelResponse` 只覆盖顶层键与数组元素，因此列表（`data.spaces` 的元素）会被
 * 完整归一，单分组响应（`data.space`）则沿用后端视图本身——`routes/web/chat-spaces.ts` 的 `toChatSpaceView`
 * 已输出 camelCase，两种响应在本模块的声明里因此都是 camelCase。
 *
 * 返回值保持 `ApiResponse` 不 unwrap：失败语义（`{ success: false }` 不 throw）由统一请求层决定，是否把
 * 失败抛给 UI 由消费方（`web/hooks/use-chat-spaces.ts`）决定，与 `instances.ts` / `environments.ts` 同口径。
 */

import { camelResponse, request } from "@fenix/web-runtime/api/request";

/** 会话分组摘要（键名归一后）；`sessionIds` 是分组归属的 ACP 会话集合，未归属的会话由前端落「默认」分组 */
export interface ChatSpaceSummary {
  id: string;
  name: string;
  sessionIds: string[];
}

/**
 * 分组视图（后端 `toChatSpaceView` 的线上形状）：摘要字段之外还有实例归属与审计时间。
 *
 * 单独声明是为了让响应类型确实等于服务端返回的字段集合（既不少声明，也不留下消费方读不到的暗字段）；
 * hook 对外只暴露其中的摘要字段 `ChatSpaceSummary`。
 */
export interface ChatSpaceView extends ChatSpaceSummary {
  instanceUid: string;
  createdAt: string;
  updatedAt: string;
}

/** 分组列表响应体（GET /web/chat-spaces） */
export interface ChatSpaceListPayload {
  /** 当前用户在该实例下的全部分组；空数组表示确实没有分组，与「尚未加载」由消费方区分 */
  spaces: ChatSpaceView[];
}

/** 单分组响应体（创建 / 重命名 / 移入共用）：变更后的权威状态 */
export interface ChatSpaceMutationPayload {
  space: ChatSpaceView;
}

/**
 * 取消归属响应体（DELETE）。
 *
 * `space` 为 `null` 表示会话本就不在任何分组（本次没有行被改动）——后端仍返回成功（幂等），
 * 消费方不必把它当失败处理。调用方不指定分组：摘除范围由服务端的 scope 决定。
 */
export interface ChatSpaceRemovalPayload {
  space: ChatSpaceView | null;
}

export const chatSpaceApi = {
  /** 列出某持久实例下的全部分组（GET /web/chat-spaces?instanceUid=） */
  list: (params: { instanceUid: string }) =>
    camelResponse(
      request<ChatSpaceListPayload>("/web/chat-spaces", {
        method: "GET",
        query: { instanceUid: params.instanceUid },
      }),
    ),

  /** 新建分组（POST /web/chat-spaces）；同实例同属主下重名由后端判 409 */
  create: (body: { instanceUid: string; name: string }) =>
    camelResponse(request<ChatSpaceMutationPayload>("/web/chat-spaces", { method: "POST", body })),

  /**
   * 重命名分组（PATCH /web/chat-spaces/:id?instanceUid=）。
   *
   * 与 assign 一样带上 `instanceUid`（在 query 上，不是路径参数）：它是服务端的权威作用域，分组 id 只在
   * 该实例内解析，跨实例一律 404。
   */
  rename: (params: { id: string; instanceUid: string }, body: { name: string }) =>
    camelResponse(
      request<ChatSpaceMutationPayload>("/web/chat-spaces/:id", {
        method: "PATCH",
        params: { id: params.id },
        query: { instanceUid: params.instanceUid },
        body,
      }),
    ),

  /** 把会话移入分组（PUT /web/chat-spaces/:id/sessions/:sessionId?instanceUid=）；该会话的原分组由后端在同一事务内摘除 */
  assign: (params: { id: string; sessionId: string; instanceUid: string }) =>
    camelResponse(
      request<ChatSpaceMutationPayload>("/web/chat-spaces/:id/sessions/:sessionId", {
        method: "PUT",
        params: { id: params.id, sessionId: params.sessionId },
        query: { instanceUid: params.instanceUid },
      }),
    ),

  /**
   * 取消会话归属（DELETE /web/chat-spaces/sessions/:sessionId?instanceUid=）。
   *
   * 路径不带分组 id：调用方表达「不再属于任何分组」，摘除范围由服务端按 scope 决定——客户端不必
   * （也不该）先反查会话当前属于哪个分组，那份反查会被滞后快照骗到旧分组。会话本就不在任何分组时
   * 同样返回成功（幂等），`data.space` 为 `null`。
   */
  unassign: (params: { sessionId: string; instanceUid: string }) =>
    camelResponse(
      request<ChatSpaceRemovalPayload>("/web/chat-spaces/sessions/:sessionId", {
        method: "DELETE",
        params: { sessionId: params.sessionId },
        query: { instanceUid: params.instanceUid },
      }),
    ),
};
