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
