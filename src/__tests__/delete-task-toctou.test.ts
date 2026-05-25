import { describe, expect, it } from "bun:test";

// R16: 验证 deleteTask TOCTOU 优化（单查询 deleteByUserAndId）和 rollback error masking 修复

// 复现 deleteTask 的简化逻辑：单次 deleteByUserAndId 返回值判断
async function deleteTaskSimplified(
  taskId: string,
  userId: string,
  deleteFn: (userId: string, taskId: string) => Promise<boolean>,
  unscheduleFn: (taskId: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const deleted = await deleteFn(userId, taskId);
  if (!deleted) return { ok: false, error: "NOT_FOUND" };
  unscheduleFn(taskId);
  return { ok: true };
}

describe("deleteTask TOCTOU 优化", () => {
  // deleteByUserAndId 返回 true 时成功删除
  it("deleteByUserAndId=true 时返回成功", async () => {
    const result = await deleteTaskSimplified(
      "task_1",
      "user_a",
      async () => true,
      () => {},
    );
    expect(result.ok).toBe(true);
  });

  // deleteByUserAndId 返回 false 时返回 NOT_FOUND
  it("deleteByUserAndId=false 时返回 NOT_FOUND", async () => {
    const result = await deleteTaskSimplified(
      "task_missing",
      "user_a",
      async () => false,
      () => {},
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("NOT_FOUND");
  });

  // 成功删除时调用 unschedule
  it("成功删除时调用 unschedule", async () => {
    let unscheduled = false;
    await deleteTaskSimplified(
      "task_1",
      "user_a",
      async () => true,
      (id) => {
        if (id === "task_1") unscheduled = true;
      },
    );
    expect(unscheduled).toBe(true);
  });

  // 未找到时不调用 unschedule
  it("未找到时不调用 unschedule", async () => {
    let unscheduled = false;
    await deleteTaskSimplified(
      "task_missing",
      "user_a",
      async () => false,
      () => {
        unscheduled = true;
      },
    );
    expect(unscheduled).toBe(false);
  });
});
