import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/**
 * Provider / Model 的配置协议面。
 *
 * 这里只保留新路由**实际**引用的契约（保存、拉取模型、模型操作、连通性测试、用户模型偏好）。
 *
 * 已按「无消费者即删除」清理过两批：
 *
 * - 旧栈的 `ProviderInfoSchema` / `ProviderDetailSchema` / `*BodySchema` / `ModelEntrySchema` 描述的是
 *   `resourceAccess` + `resourceKey` 视图，`/web` 已改返回 `scope + access`（决策 D2）；它们还把旧权限栈的
 *   `ResourceAccessSchema` 拖进了宿主的 schema 面，删除后 `apps/server` 不再引用 `@fenix/access-control`
 *   的协议类型。
 * - 通用 `ConfigActionSchema` / `ConfigBodySchema`（`POST /web/config/:module` 的 action 风格请求体，
 *   该路由已不再注册）与 `Mcp*Schema` 一组（mcp 的协议 schema 已在 `@fenix/resource-mcp` 内，
 *   前端用的是它自己的视图类型），二者在宿主内只剩 barrel 再导出。
 *
 * 资源包的路由从这里 import 响应 schema，是因为 `/web/config/*` 的这组契约仍登记在宿主 schema 面；
 * 若后续把它们下沉到各资源包，本文件应只剩宿主自己的协议。
 */

// ── Provider REST 响应 ──

/** Provider 创建 / 更新响应 */
export const ProviderSaveResponseSchema = WebOkSchema(
  z.object({
    id: z.string().describe("Provider 名称。"),
    name: z.string().nullable().describe("Provider 展示名称。"),
    protocol: z.enum(["openai", "anthropic"]).describe("Provider 协议类型。"),
    keyHint: z.string().nullable().describe("API Key 提示信息。"),
  }),
).describe("Provider 创建 / 更新响应。");

/** Provider 模型列表获取响应 */
export const ProviderFetchModelsResponseSchema = WebOkSchema(
  z.object({
    models: z.array(z.string()).describe("Provider 提供的模型 ID 列表。"),
  }),
).describe("Provider 模型列表获取响应。");

/** 模型操作（添加/更新/删除）响应 */
export const ModelActionResultResponseSchema = WebOkSchema(
  z.object({
    modelId: z.string().describe("操作的模型 ID。"),
  }),
).describe("模型操作结果响应。");

/** 模型连通性测试响应 */
export const ModelTestResponseSchema = WebOkSchema(
  z.object({
    ok: z.boolean().describe("模型是否连通。"),
    content: z.string().describe("模型返回的测试消息内容。"),
  }),
).describe("模型连通性测试响应。");

// ── Models ──

/** PUT /web/config/models 的请求体：更新用户模型偏好。 */
export const ModelPreferencesBodySchema = z
  .object({
    model: z.string().optional().describe("用户偏好的主模型引用（provider/model 格式）。"),
    small_model: z.string().optional().describe("用户偏好的轻量模型引用（provider/model 格式）。"),
    permission: z.unknown().optional().describe("用户权限配置对象。"),
  })
  .describe("模型偏好更新请求体。");

/** PUT /web/config/models 的响应体。 */
export const ModelPreferencesResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    model: z.string().nullable().describe("更新后的主模型引用。"),
    small_model: z.string().nullable().describe("更新后的轻量模型引用。"),
    permission: z.unknown().nullable().describe("更新后的权限配置。"),
  }),
});

/** POST /web/config/models/refresh 的响应体。 */
export const ModelRefreshResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    count: z.number().describe("刷新后可用模型数量。"),
  }),
});
