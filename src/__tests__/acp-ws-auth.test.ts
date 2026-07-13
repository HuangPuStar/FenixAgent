import { describe, expect, test } from "bun:test";

describe("/acp/ws 端点迁移为 socket.io", () => {
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

  test("/acp/ws Elysia WS 路由已移除（迁移为 socket.io）", async () => {
    const fs = await import("node:fs");
    const content = fs.readFileSync(`${import.meta.dirname}/../routes/acp/index.ts`, "utf-8");
    // 旧 Elysia WS 路由(.ws)和 WebSocket 相关代码已不存在
    expect(content.includes(".ws(")).toBe(false);
    // token-based auth 已移除
    expect(content.includes("resolveTokenAuth")).toBe(false);
  });
});
