/**
 * 品牌配置 Web 路由。
 *
 * 迁移自 `packages/resources/identity-admin/src/server/routes/web/branding.ts`：品牌配置属于控制台壳展示
 * 职责而非身份职责（CE/EE 重构决策 D4），随身份包拆分落位到宿主 `apps/server`。路由前缀、路径、
 * 方法与响应形状保持逐字一致（`/web/branding`、`/web/branding/logo`），前端契约不变。
 */

import Elysia from "elysia";
import { BrandingConfigResponseSchema, BrandingLogoNotFoundResponseSchema } from "../../schemas/branding.schema";
import { getBrandingConfig, resolveBrandLogoFile } from "../../services/branding";

const app = new Elysia({ name: "web-branding", prefix: "/branding" })
  .model({
    "branding-config-response": BrandingConfigResponseSchema,
    "branding-logo-not-found-response": BrandingLogoNotFoundResponseSchema,
  })
  .get(
    "/",
    () => {
      const branding = getBrandingConfig();
      return {
        success: true as const,
        data: {
          brandName: branding.brandName,
          logoUrl: branding.logoUrl,
        },
      };
    },
    {
      response: "branding-config-response",
      detail: {
        tags: ["Branding"],
        summary: "获取品牌配置",
        description: "返回当前系统展示使用的品牌名称和 Logo 地址配置。",
      },
    },
  )
  .get(
    "/logo",
    ({ set }) => {
      const logoFile = resolveBrandLogoFile();
      if (!logoFile) {
        return new Response(
          JSON.stringify({
            success: false as const,
            error: { code: "NOT_FOUND", message: "Brand logo not found" },
          }),
          {
            status: 404,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          },
        );
      }

      const file = Bun.file(logoFile);
      set.headers["Cache-Control"] = "public, max-age=300";
      if (file.type) {
        set.headers["Content-Type"] = file.type;
      }
      return new Response(file);
    },
    {
      detail: {
        tags: ["Branding"],
        summary: "获取品牌 Logo 文件",
        description: "返回当前配置的品牌 Logo 原始文件内容；若未配置 Logo，则返回 404 错误响应。",
        responses: {
          200: {
            description: "品牌 Logo 文件流。",
            content: {
              "image/*": {
                schema: {
                  type: "string",
                  format: "binary",
                },
              },
            },
          },
          404: {
            description: "未找到品牌 Logo。",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/branding-logo-not-found-response",
                },
              },
            },
          },
        },
      },
    },
  );

export default app;
