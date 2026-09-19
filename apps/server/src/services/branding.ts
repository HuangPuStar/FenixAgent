/**
 * 品牌配置服务。
 *
 * 迁移自 `packages/resources/identity-admin/src/server/services/branding.ts`：品牌配置由环境变量派生，
 * 属于控制台壳的展示职责而非身份职责（CE/EE 重构决策 D4），因此随身份包拆分落位到宿主 `apps/server`。
 * 逻辑保持逐字一致，仅新增本说明注释。
 */

import { existsSync } from "node:fs";

const DEFAULT_BRAND_NAME = "Fenix";

export interface BrandingConfig {
  brandName: string;
  logoPath: string | null;
  logoUrl: string | null;
}

/**
 * Returns the public branding configuration derived from environment variables.
 */
export function getBrandingConfig(): BrandingConfig {
  const brandName = process.env.APP_BRAND_NAME?.trim() || DEFAULT_BRAND_NAME;
  const logoPath = process.env.APP_LOGO_PATH?.trim() || null;

  return {
    brandName,
    logoPath,
    logoUrl: logoPath ? "/web/branding/logo" : null,
  };
}

/**
 * Resolves the configured logo file path when it exists on disk.
 */
export function resolveBrandLogoFile(): string | null {
  const { logoPath } = getBrandingConfig();
  if (!logoPath) return null;
  return existsSync(logoPath) ? logoPath : null;
}
