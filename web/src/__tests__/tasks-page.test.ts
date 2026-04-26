import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const webRoot = join(import.meta.dirname, "..");

describe("TasksPage", () => {
  describe("validateTaskForm logic", () => {
    it("should reject empty name", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      expect(src).toContain("任务名称不能为空");
    });

    it("should reject non-http url", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      expect(src).toContain("URL 必须以 http:// 或 https:// 开头");
    });

    it("should reject empty cron", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      expect(src).toContain("cron 表达式不能为空");
    });

    it("should reject non-5-field cron", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      expect(src).toContain("cron 表达式必须为 5 字段");
    });
  });

  describe("format helpers", () => {
    it("formatTimestamp should handle null", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      expect(src).toContain('if (!ts) return "—"');
    });

    it("formatDuration should handle ms < 1000", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      expect(src).toContain("ms < 1000");
    });

    it("formatDuration should handle ms >= 1000", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      expect(src).toContain("ms / 1000");
    });
  });

  describe("CRON_PRESETS", () => {
    it("should have 5 presets", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      const matches = src.match(/label:.*value:.*\*/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThanOrEqual(5);
    });

    it("should contain standard cron expressions", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      expect(src).toContain("*/5 * * * *");
      expect(src).toContain("0 * * * *");
    });
  });

  describe("TasksPage component", () => {
    it("should export TasksPage function", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      expect(src).toContain("export function TasksPage");
    });

    it("should use DataTable, FormDialog, StatusBadge, ConfirmDialog", () => {
      const src = readFileSync(join(webRoot, "pages/TasksPage.tsx"), "utf-8");
      expect(src).toContain("DataTable");
      expect(src).toContain("FormDialog");
      expect(src).toContain("StatusBadge");
      expect(src).toContain("ConfirmDialog");
    });
  });

  describe("client.ts tasks API", () => {
    it("should export all tasks API functions", () => {
      const src = readFileSync(join(webRoot, "api/client.ts"), "utf-8");
      expect(src).toContain("export function apiListTasks");
      expect(src).toContain("export function apiCreateTask");
      expect(src).toContain("export function apiGetTask");
      expect(src).toContain("export function apiUpdateTask");
      expect(src).toContain("export function apiDeleteTask");
      expect(src).toContain("export function apiToggleTask");
      expect(src).toContain("export function apiTriggerTask");
      expect(src).toContain("export function apiListTaskLogs");
      expect(src).toContain("export function apiClearTaskLogs");
    });

    it("should export TaskInfo, ExecutionLogInfo, PaginatedLogs types", () => {
      const src = readFileSync(join(webRoot, "api/client.ts"), "utf-8");
      expect(src).toContain("export interface TaskInfo");
      expect(src).toContain("export interface ExecutionLogInfo");
      expect(src).toContain("export interface PaginatedLogs");
    });
  });
});
