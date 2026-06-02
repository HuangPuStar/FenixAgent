import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBrandingConfig, resolveBrandLogoFile } from "../services/branding";

describe("branding service", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  test("未配置时回退默认品牌", () => {
    delete process.env.APP_BRAND_NAME;
    delete process.env.APP_LOGO_PATH;

    const branding = getBrandingConfig();
    expect(branding.brandName).toBe("Fenix");
    expect(branding.logoUrl).toBeNull();
  });

  test("存在 logo 文件时返回固定对外 URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "branding-"));
    const logoPath = join(dir, "logo.png");
    writeFileSync(logoPath, "png");

    process.env.APP_BRAND_NAME = "Test Brand";
    process.env.APP_LOGO_PATH = logoPath;

    const branding = getBrandingConfig();
    expect(branding.brandName).toBe("Test Brand");
    expect(branding.logoUrl).toBe("/web/branding/logo");
    expect(resolveBrandLogoFile()).toBe(logoPath);
  });
});
