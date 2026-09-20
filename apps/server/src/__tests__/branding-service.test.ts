// 品牌配置服务测试：迁移自 packages/resources/identity-admin/src/__tests__/branding-service.test.ts，
// 随品牌能力（CE/EE 重构决策 D4）落位到宿主 apps/server，断言保持不变。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBrandingConfig, resolveBrandLogoFile } from "../services/branding";

describe("branding service", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略清理错误
      }
    }
    tempDirs.length = 0;
  });

  // 未配置品牌环境变量时应回退到默认品牌且不暴露 Logo 地址。
  test("未配置时回退默认品牌", () => {
    delete process.env.APP_BRAND_NAME;
    delete process.env.APP_LOGO_PATH;

    const branding = getBrandingConfig();
    expect(branding.brandName).toBe("Fenix");
    expect(branding.logoUrl).toBeNull();
  });

  // 配置了存在的 Logo 文件时应返回固定对外 URL 并解析出磁盘路径。
  test("存在 logo 文件时返回固定对外 URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "branding-"));
    tempDirs.push(dir);
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
