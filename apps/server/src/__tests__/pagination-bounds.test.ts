import { describe, expect, it } from "bun:test";

// 测试 task.ts listExecutionLogs 的分页边界逻辑（纯函数测试）

function clampPagination(page: number, pageSize: number): { page: number; pageSize: number } {
  return {
    page: Math.max(1, Math.floor(page)),
    pageSize: Math.min(100, Math.max(1, Math.floor(pageSize))),
  };
}

describe("listExecutionLogs pagination bounds", () => {
  // 正常值不变
  it("正常值不变", () => {
    expect(clampPagination(1, 20)).toEqual({ page: 1, pageSize: 20 });
    expect(clampPagination(3, 50)).toEqual({ page: 3, pageSize: 50 });
  });

  // page <= 0 钳位到 1
  it("page <= 0 钳位到 1", () => {
    expect(clampPagination(0, 20)).toEqual({ page: 1, pageSize: 20 });
    expect(clampPagination(-5, 20)).toEqual({ page: 1, pageSize: 20 });
  });

  // 浮点 page 向下取整
  it("浮点 page 向下取整", () => {
    expect(clampPagination(2.7, 20)).toEqual({ page: 2, pageSize: 20 });
  });

  // pageSize <= 0 钳位到 1
  it("pageSize <= 0 钳位到 1", () => {
    expect(clampPagination(1, 0)).toEqual({ page: 1, pageSize: 1 });
    expect(clampPagination(1, -10)).toEqual({ page: 1, pageSize: 1 });
  });

  // pageSize > 100 钳位到 100
  it("pageSize > 100 钳位到 100", () => {
    expect(clampPagination(1, 999999)).toEqual({ page: 1, pageSize: 100 });
  });

  // 浮点 pageSize 向下取整
  it("浮点 pageSize 向下取整", () => {
    expect(clampPagination(1, 15.9)).toEqual({ page: 1, pageSize: 15 });
  });
});
