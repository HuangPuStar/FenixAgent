import { describe, expect, spyOn, test } from "bun:test";
import type { TaskV2Info } from "../api/tasks-v2";
import {
  buildTaskDefinition,
  projectCronOccurrences,
  projectTaskTime,
  taskFormSchema,
  taskToFormValues,
} from "../pages/agent-panel/pages/agent-tasks-utils";

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
  // cron 字段越界时必须在前端阻止提交，不能生成看似合理的时间描述。
  test("rejects cron expressions with out-of-range fields", () => {
    expect(
      taskFormSchema.safeParse({
        type: "http",
        name: "Webhook",
        cron: "70 34 32 * *",
        timezone: "Asia/Shanghai",
        timeoutSeconds: 30,
        url: "https://example.com/hook",
      }).success,
    ).toBe(false);
  });

  // 合法 cron 和时区组合应通过前端表单校验。
  test("accepts a valid cron expression and timezone", () => {
    expect(
      taskFormSchema.safeParse({
        type: "http",
        name: "Webhook",
        cron: "0 9 * * 1-5",
        timezone: "Asia/Shanghai",
        timeoutSeconds: 30,
        url: "https://example.com/hook",
      }).success,
    ).toBe(true);
  });

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
  // 时间轴应依据当前选择的窗口投影，避免切换 1/12/24 小时后仍沿用固定比例。
  test("projects timestamps inside the selected runtime window", () => {
    const now = new Date("2026-08-26T10:20:00+08:00").getTime();
    expect(projectTaskTime((now + 30 * 60 * 1000) / 1000, now, 1)).toBe(50);
    expect(projectTaskTime((now - 1) / 1000, now, 1)).toBeNull();
    expect(projectTaskTime((now + 61 * 60 * 1000) / 1000, now, 1)).toBeNull();
  });

  // 高频 cron 必须展开窗口内的每次未来触发，不能只展示后端 nextRunAt 单点。
  test("projects every five-minute cron occurrence in the next 24 hours", () => {
    const now = new Date("2026-08-26T10:02:00+08:00").getTime();
    const nextRunAt = new Date("2026-08-26T10:05:00+08:00").getTime() / 1000;
    const positions = projectCronOccurrences("*/5 * * * *", "Asia/Shanghai", now, nextRunAt);
    expect(positions).toHaveLength(288);
    expect(positions[0]).toBeCloseTo((3 / 1_440) * 100, 5);
    expect(positions.at(-1)).toBeCloseTo((1_438 / 1_440) * 100, 5);
  });

  // 默认一小时视图必须把每五分钟的全部未来触发显示出来，而不是退化为单个 nextRunAt 点。
  test("projects every five-minute occurrence in the one-hour window", () => {
    const now = new Date("2026-08-26T10:02:00+08:00").getTime();
    const nextRunAt = new Date("2026-08-26T10:05:00+08:00").getTime() / 1000;
    expect(projectCronOccurrences("*/5 * * * *", "Asia/Shanghai", now, nextRunAt, 1)).toHaveLength(12);
  });

  // 暂停任务可能没有 nextRunAt，高频计划仍需通过 cron 首次触发点展开完整时间轴。
  test("projects fixed-minute cron occurrences without a server anchor", () => {
    const now = new Date("2026-08-26T10:02:00+08:00").getTime();
    expect(projectCronOccurrences("*/1 * * * *", "Asia/Shanghai", now)).toHaveLength(1_440);
  });

  // 无效 cron 不应让运行排布崩溃，页面会回退到后端 nextRunAt。
  test("returns an empty projection for an invalid cron", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(projectCronOccurrences("not-a-cron", "UTC", Date.now())).toEqual([]);
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});
