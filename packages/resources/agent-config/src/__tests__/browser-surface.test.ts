import { describe, expect, test } from "bun:test";

const browserEntryPath = new URL("../index.ts", import.meta.url);

describe("AgentConfig 浏览器入口", () => {
  // 根入口只能暴露浏览器能力，不能把服务端依赖带入 Vite bundle。
  test("不重导出服务端模块", async () => {
    const entry = await Bun.file(browserEntryPath).text();

    expect(entry).not.toContain('from "./server"');
    expect(entry).not.toContain("from './server'");
  });

  // 公开入口必须保留实际浏览器能力，完整依赖图由 Vite 生产构建验证。
  test("导出 Agent 配置与站点浏览器 API", async () => {
    const entry = await Bun.file(browserEntryPath).text();

    expect(entry).toContain('export * from "../web/api/agents"');
    expect(entry).toContain('export * from "../web/api/sites"');
  });
});
