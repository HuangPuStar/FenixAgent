import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/**
 * `/web/config/providers` 与 `/web/config/models` 的协议契约。
 *
 * 从宿主 `apps/server/src/schemas/config.schema.ts` 迁入：该文件里的 Provider / Model 契约**全部**只有
 * 本包的两条路由引用（实测 `command grep -rn "schemas/config.schema" apps packages`：宿主侧仅
 * `schemas/index.ts` 的一条注释声明「不经本 barrel 转发，资源包直接 import 该文件」），宿主文件自身的
 * 注释也已写明「若后续把它们下沉到各资源包，本文件应只剩宿主自己的协议」。迁移后宿主那份已无消费者，
 * 删除登记在 `sharedPatches`。
 *
 * 字段名、schema 别名（Elysia `.model()` 的键）与 `.describe()` 文案逐字保留：它们是对外协议的一部分，
 * 也是 OpenAPI 文档的输入。
 */

/** Provider 创建 / 更新响应。 */
export const ProviderSaveResponseSchema = WebOkSchema(
  z.object({
    id: z.string().describe("Provider 名称。"),
    name: z.string().nullable().describe("Provider 展示名称。"),
    protocol: z.enum(["openai", "anthropic"]).describe("Provider 协议类型。"),
    keyHint: z.string().nullable().describe("API Key 提示信息。"),
  }),
).describe("Provider 创建 / 更新响应。");

/** Provider 模型列表获取响应。 */
export const ProviderFetchModelsResponseSchema = WebOkSchema(
  z.object({
    models: z.array(z.string()).describe("Provider 提供的模型 ID 列表。"),
  }),
).describe("Provider 模型列表获取响应。");

/** 模型操作（添加/更新/删除）响应。 */
export const ModelActionResultResponseSchema = WebOkSchema(
  z.object({
    modelId: z.string().describe("操作的模型 ID。"),
  }),
).describe("模型操作结果响应。");

/** 模型连通性测试响应。 */
export const ModelTestResponseSchema = WebOkSchema(
  z.object({
    ok: z.boolean().describe("模型是否连通。"),
    content: z.string().describe("模型返回的测试消息内容。"),
  }),
).describe("模型连通性测试响应。");

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
