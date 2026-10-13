// 品牌配置 Web 路由测试：迁移自 packages/resources/identity-admin/src/__tests__/web-branding-routes.test.ts，
// 随品牌能力（CE/EE 重构决策 D4）落位到宿主 apps/server；路由前缀与响应契约保持逐字一致。

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Elysia from "elysia";
import webBranding from "../routes/web/branding";

describe("web branding routes", () => {
  const originalEnv = { ...process.env };
  const app = new Elysia().use(webBranding);
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

  // 未配置品牌时应返回默认品牌名称与空的 Logo 地址。
  test("GET /branding 返回默认品牌配置", async () => {
    delete process.env.APP_BRAND_NAME;
    delete process.env.APP_LOGO_PATH;

    const response = await app.handle(new Request("http://localhost/branding"));
    const payload = (await response.json()) as {
      success: boolean;
      data: { brandName: string; logoUrl: string | null };
    };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.brandName).toBe("Fenix");
    expect(payload.data.logoUrl).toBeNull();
  });

  // 配置的 Logo 文件不存在时必须返回 404，不得静默回退到默认图标。
  test("GET /branding/logo 在文件缺失时返回 404", async () => {
    process.env.APP_LOGO_PATH = "/tmp/does-not-exist-logo.png";

    const response = await app.handle(new Request("http://localhost/branding/logo"));
    expect(response.status).toBe(404);
  });

  // 配置的 Logo 文件存在时应原样返回文件内容。
  test("GET /branding/logo 返回本地 logo 文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "branding-route-"));
    tempDirs.push(dir);
    const logoPath = join(dir, "logo.svg");
    const logoContent = `<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
    writeFileSync(logoPath, logoContent);
    process.env.APP_LOGO_PATH = logoPath;

    const response = await app.handle(new Request("http://localhost/branding/logo"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(logoContent);
  });
});
