import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(import.meta.dirname, "..");

describe("TasksPage", () => {
  it("contains environment/task/task timeout state and environment loading", () => {
    const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
    expect(src).toContain("apiFetchEnvironments");
    expect(src).toContain("environmentId");
    expect(src).toContain("timeoutMinutes");
    expect(src).toContain("LOCAL_TIMEZONE_SENTINEL");
  });

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

  it("contains workspace browsing UI in logs dialog", () => {
    const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
    expect(src).toContain("workspacePath");
    expect(src).toContain("resultSummary");
    expect(src).toContain("查看目录");
    expect(src).toContain("apiListFiles");
  });
});

describe("client.ts tasks API", () => {
  it("exports task and execution log types with new fields", () => {
    const src = readFileSync(join(webRoot, "api/client.ts"), "utf-8");
    expect(src).toContain("export interface TaskInfo");
    expect(src).toContain("environmentId");
    expect(src).toContain("environmentName");
    expect(src).toContain("task");
    expect(src).toContain("timeoutMinutes");
    expect(src).toContain("export interface ExecutionLogInfo");
    expect(src).toContain("workspacePath");
    expect(src).toContain("taskSnapshot");
    expect(src).toContain("resultSummary");
  });
});
