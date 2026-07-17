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

  test("GET /branding/logo 在文件缺失时返回 404", async () => {
    process.env.APP_LOGO_PATH = "/tmp/does-not-exist-logo.png";

    const response = await app.handle(new Request("http://localhost/branding/logo"));
    expect(response.status).toBe(404);
  });

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
