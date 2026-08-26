import { describe, expect, test } from "bun:test";
import type { TaskV2Info } from "../api/tasks-v2";
import { buildTaskDefinition, projectTaskTime, taskToFormValues } from "../pages/agent-panel/pages/agent-tasks-utils";

const task: TaskV2Info = {
  id: "task-1",
  name: "每日巡检",
  description: "检查服务状态",
  cron: "0 9 * * *",
  timezone: "Asia/Shanghai",
  enabled: true,
  timeoutSeconds: 300,
  agentId: "agent-1",
  type: "agent",
  definition: { prompt: "检查状态" },
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("task view model conversion", () => {
  // 任务 DTO 转换为编辑器值时必须保留 Agent、Prompt 和计划配置。
  test("maps task data into form values", () => {
    expect(taskToFormValues(task)).toMatchObject({
      type: "agent",
      name: "每日巡检",
      cron: "0 9 * * *",
      agentId: "agent-1",
      prompt: "检查状态",
    });
  });

  // HTTP 表单应转换为后端真实 definition，避免时间轴视图影响保存协议。
  test("builds HTTP task definition", () => {
    expect(
      buildTaskDefinition({
        type: "http",
        name: "Webhook",
        cron: "0 * * * *",
        timezone: "",
        timeoutSeconds: 30,
        description: "",
        url: "https://example.com/hook",
        method: "POST",
        headers: '{"X-Test":"1"}',
        body: "{}",
        agentId: "",
        prompt: "",
      }),
    ).toEqual({ url: "https://example.com/hook", method: "POST", headers: { "X-Test": "1" }, body: "{}" });
  });
});

describe("task runtime projection", () => {
  // 时间轴只投影当前整点起 24 小时内的数据，避免越界色块误导用户。
  test("projects timestamps inside the 24-hour window", () => {
    const now = new Date("2026-08-26T10:20:00+08:00").getTime();
    const start = new Date("2026-08-26T10:00:00+08:00").getTime();
    expect(projectTaskTime((start + 12 * 60 * 60 * 1000) / 1000, now)).toBe(50);
    expect(projectTaskTime((start - 1) / 1000, now)).toBeNull();
    expect(projectTaskTime((start + 25 * 60 * 60 * 1000) / 1000, now)).toBeNull();
  });
});
