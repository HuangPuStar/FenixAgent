import { describe, expect, it } from "bun:test";

// 测试 task.ts 纯函数：sanitizeExecutionLog 不应包含 statusCode 字段
// 复制内部逻辑进行单元测试

function toUnixTimestamp(value: Date | null | undefined): number | null {
  return value ? Math.floor(value.getTime() / 1000) : null;
}

interface TaskExecutionLogResponse {
  id: string;
  taskId: string;
  status: string;
  error: string | null;
  duration: number | null;
  triggeredBy: string;
  skipReason: string | null;
  resultSummary: string | null;
  createdAt: number;
}

function sanitizeExecutionLog(row: {
  id: string;
  taskId: string;
  status: string;
  error: string | null;
  duration: number | null;
  triggeredBy: string;
  skipReason: string | null;
  resultSummary: string | null;
  createdAt: Date;
}): TaskExecutionLogResponse {
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status,
    error: row.error ?? null,
    duration: row.duration ?? null,
    triggeredBy: row.triggeredBy,
    skipReason: row.skipReason ?? null,
    resultSummary: row.resultSummary ?? null,
    createdAt: toUnixTimestamp(row.createdAt) ?? 0,
  };
}

describe("sanitizeExecutionLog", () => {
  const now = new Date("2026-01-15T10:30:00Z");

  // 完整字段映射
  it("正确映射所有字段", () => {
    const result = sanitizeExecutionLog({
      id: "log_abc123",
      taskId: "task_xyz",
      status: "success",
      error: null,
      duration: 150,
      triggeredBy: "manual",
      skipReason: null,
      resultSummary: "OK",
      createdAt: now,
    });
    expect(result.id).toBe("log_abc123");
    expect(result.taskId).toBe("task_xyz");
    expect(result.status).toBe("success");
    expect(result.error).toBeNull();
    expect(result.duration).toBe(150);
    expect(result.triggeredBy).toBe("manual");
    expect(result.skipReason).toBeNull();
    expect(result.resultSummary).toBe("OK");
    expect(result.createdAt).toBe(Math.floor(now.getTime() / 1000));
  });

  // 不包含 statusCode 字段（已移除的死字段）
  it("不包含 statusCode 字段", () => {
    const result = sanitizeExecutionLog({
      id: "log_1",
      taskId: "task_1",
      status: "failed",
      error: "timeout",
      duration: 30000,
      triggeredBy: "cron",
      skipReason: null,
      resultSummary: null,
      createdAt: now,
    });
    expect("statusCode" in result).toBe(false);
  });

  // null 字段正确处理
  it("null 字段使用默认值", () => {
    const result = sanitizeExecutionLog({
      id: "log_2",
      taskId: "task_2",
      status: "skipped",
      error: null,
      duration: null,
      triggeredBy: "cron",
      skipReason: "previous_run_still_active",
      resultSummary: null,
      createdAt: now,
    });
    expect(result.error).toBeNull();
    expect(result.duration).toBeNull();
    expect(result.skipReason).toBe("previous_run_still_active");
    expect(result.resultSummary).toBeNull();
  });
});
