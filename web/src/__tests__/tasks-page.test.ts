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
  // 测试 sdk.ts 导出所有必要的 API 模块（源码检查，避免 @fenix/sdk 路径解析问题）
  it("exports SDK modules from api/sdk", () => {
    const src = readFileSync(join(webRoot, "api/sdk.ts"), "utf-8");
    expect(src).toContain("providerApi");
    expect(src).toContain("agentApi");
    expect(src).toContain("envApi");
    expect(src).toContain("sessionApi");
    expect(src).toContain("mcpApi");
    expect(src).toContain("taskApi");
  });
});
