import { describe, expect, test } from "bun:test";

describe("/acp/ws 端点认证简化", () => {
  test("resolveTokenAuth 已从文件中移除", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(`${import.meta.dirname}/../routes/acp/index.ts`, "utf-8");
    expect(content.includes("resolveTokenAuth")).toBe(false);
  });

  test("getEnvironmentBySecret 导入已移除", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(`${import.meta.dirname}/../routes/acp/index.ts`, "utf-8");
    expect(content.includes("getEnvironmentBySecret")).toBe(false);
  });

  test("lookupUserById 导入已移除", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(`${import.meta.dirname}/../routes/acp/index.ts`, "utf-8");
    expect(content.includes("lookupUserById")).toBe(false);
  });

  test("/acp/ws 只保留 REGISTRY_SECRET 认证", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(`${import.meta.dirname}/../routes/acp/index.ts`, "utf-8");
    // 验证 secret 参数检查和 4003 关闭逻辑存在
    expect(content.includes("4003")).toBe(true);
    expect(content.includes("REGISTRY_SECRET")).toBe(true);
    // 验证 token-based auth 已移除
    expect(content.includes("resolveTokenAuth")).toBe(false);
  });
});
