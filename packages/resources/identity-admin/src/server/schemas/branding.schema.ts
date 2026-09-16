import * as z from "zod/v4";

/** 品牌配置数据 */
export const BrandingConfigSchema = z
  .object({
    brandName: z.string().describe("品牌名称。"),
    logoUrl: z.string().nullable().describe("品牌 Logo 访问地址；未配置时为 null。"),
  })
  .describe("品牌配置数据。");

/** GET /web/branding 成功响应 */
export const BrandingConfigResponseSchema = z
  .object({
    success: z.literal(true).describe("请求是否成功。"),
    data: BrandingConfigSchema.describe("当前品牌配置。"),
  })
  .describe("获取品牌配置的响应。");

/** GET /web/branding/logo 未找到时的错误响应 */
export const BrandingLogoNotFoundResponseSchema = z
  .object({
    success: z.literal(false).describe("请求失败。"),
    error: z.object({
      code: z.literal("NOT_FOUND").describe("错误码。"),
      message: z.string().describe("错误信息。"),
    }),
  })
  .describe("品牌 Logo 未配置时的错误响应。");

export type BrandingConfig = z.infer<typeof BrandingConfigSchema>;
export type BrandingConfigResponse = z.infer<typeof BrandingConfigResponseSchema>;
export type BrandingLogoNotFoundResponse = z.infer<typeof BrandingLogoNotFoundResponseSchema>;
