import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(import.meta.dirname, "..");

describe("TasksPage", () => {
  // 测试包含环境和任务相关状态
  it("contains environment/task/task timeout state and environment loading", () => {
    const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
    expect(src).toContain("environmentId");
    expect(src).toContain("timeoutMinutes");
    expect(src).toContain("formEnvironmentId");
  });

  // 测试移除旧版 HTTP 表单标签
  it("removes legacy HTTP form labels", () => {
    const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
    expect(src).not.toContain(["UR", "L *"].join(""));
    expect(src).not.toContain(["请求", "头"].join(""));
    expect(src).not.toContain(["请求体 ", "(JSON)"].join(""));
    expect(src).not.toContain(["启用自动", "重试"].join(""));
    expect(src).not.toContain(["form", "Method"].join(""));
    expect(src).not.toContain(["form", "Headers"].join(""));
    expect(src).not.toContain(["form", "Retry"].join(""));
  });

  // 测试包含日志对话框中的工作区浏览 UI
  it("contains workspace browsing UI in logs dialog", () => {
    const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
    expect(src).toContain("workspacePath");
    expect(src).toContain("resultSummary");
    expect(src).toContain("viewDirectory");
  });
});

describe("sdk.ts exports", () => {
  // 测试导出 SDK 模块
  it("exports SDK modules from api/sdk", async () => {
    const sdkMod = await import("../api/sdk");
    expect(sdkMod.providerApi).toBeDefined();
    expect(sdkMod.agentApi).toBeDefined();
    expect(sdkMod.envApi).toBeDefined();
    expect(sdkMod.sessionApi).toBeDefined();
    expect(sdkMod.mcpApi).toBeDefined();
    expect(sdkMod.taskApi).toBeDefined();
    expect(typeof sdkMod.providerApi.list).toBe("function");
    expect(typeof sdkMod.agentApi.create).toBe("function");
    expect(typeof sdkMod.envApi.list).toBe("function");
  });
});
