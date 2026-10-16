import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/**
 * `/web/chat-spaces/**` 的协议模型。
 *
 * 视图字段与控制面既有视图同口径（camelCase + ISO 时间字符串，见 `schemas/instance.schema.ts`）：
 * 归属列（userId）不回报——调用方即属主，回报它只会让前端多一个不该使用的字段。
 *
 * 请求体的 `name` 只声明为字符串而不加长度约束：长度规则是领域规则（trim 后 1..100），由 service 统一
 * 裁决并给出 `invalid_name` 的 400；在协议层再写一遍会让同一个规则出现两份实现。
 */

/** 会话分组视图。 */
export const ChatSpaceInfoSchema = z.object({
  id: z.string().describe("分组 ID（space_ 前缀）。"),
  instanceUid: z.string().describe("分组所属的持久 Agent Instance UID。"),
  name: z.string().describe("分组名（已 trim，1-100 字符）。"),
  sessionIds: z.string().array().describe("归入本分组的 ACP 会话 ID 列表；未归属的会话由前端落在「默认」分组。"),
  createdAt: z.string().datetime().describe("创建时间（ISO 8601）。"),
  updatedAt: z.string().datetime().describe("最近一次变更时间（ISO 8601）。"),
});

/**
 * 分组操作的实例定位查询参数（GET / PATCH / PUT / DELETE 共用）。
 *
 * 四个以实例或分组为定位符的动作都在 query 上带 `instanceUid`：它是权威作用域，服务端先据此完成实例与
 * 环境的归属校验，再确认路径里的分组确实落在该实例内（见 `facades/chat-space-facade`）。
 */
export const ChatSpaceInstanceQuerySchema = z.object({
  instanceUid: z.string().describe("分组所属的持久 Agent Instance UID。"),
});

/** POST /web/chat-spaces 请求体。 */
export const ChatSpaceCreateRequestSchema = z.object({
  instanceUid: z.string().describe("分组所属的持久 Agent Instance UID。"),
  name: z.string().describe("分组名；trim 后需为 1-100 字符。"),
});

/** PATCH /web/chat-spaces/:id 请求体。 */
export const ChatSpaceRenameRequestSchema = z.object({
  name: z.string().describe("新分组名；trim 后需为 1-100 字符，同实例同属主下不得重名。"),
});

/** 分组列表响应：`{ spaces }` 包一层，与其它列表响应的数据形状一致。 */
export const ChatSpaceListResponseSchema = WebOkSchema(
  z.object({ spaces: ChatSpaceInfoSchema.array().describe("当前用户在该实例下的全部分组。") }),
).describe("会话分组列表响应。");

/** 单分组响应（创建、重命名、移入共用）。 */
export const ChatSpaceMutationResponseSchema = WebOkSchema(
  z.object({ space: ChatSpaceInfoSchema.describe("本次变更后的分组状态。") }),
).describe("会话分组变更响应。");

/**
 * 取消归属响应（DELETE）。
 *
 * `space` 可为 `null`：会话本就不在任何分组时没有任何行被改动，这与「移出成功」是同一件事（幂等），
 * 不是失败——所以它仍是 200，而不是 404。摘除由 scope 决定范围，调用方不指定分组。
 */
export const ChatSpaceRemovalResponseSchema = WebOkSchema(
  z.object({
    space: ChatSpaceInfoSchema.nullable().describe("被摘除的分组（本次变更后的状态）；会话本就不在任何分组时为 null。"),
  }),
).describe("会话移出分组响应。");

export type ChatSpaceInfo = z.infer<typeof ChatSpaceInfoSchema>;
export type ChatSpaceInstanceQuery = z.infer<typeof ChatSpaceInstanceQuerySchema>;
export type ChatSpaceCreateRequest = z.infer<typeof ChatSpaceCreateRequestSchema>;
export type ChatSpaceRenameRequest = z.infer<typeof ChatSpaceRenameRequestSchema>;
export type ChatSpaceListResponse = z.infer<typeof ChatSpaceListResponseSchema>;
export type ChatSpaceMutationResponse = z.infer<typeof ChatSpaceMutationResponseSchema>;
export type ChatSpaceRemovalResponse = z.infer<typeof ChatSpaceRemovalResponseSchema>;
