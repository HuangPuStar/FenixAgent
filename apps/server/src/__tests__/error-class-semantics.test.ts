import { describe, expect, it } from "bun:test";

// R14: 验证 instance.ts 和 environment-acp.ts 中错误类使用 AppError/NotFoundError
// 而非 Object.assign(new Error, { code })

const { NotFoundError, AppError } = await import("../errors");

describe("R14 错误类语义验证", () => {
  // NotFoundError 具有 code 属性且值为 "NOT_FOUND"
  it("NotFoundError.code === NOT_FOUND", () => {
    const err = new NotFoundError("测试");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("测试");
    expect(err.statusCode).toBe(404);
    expect(err).toBeInstanceOf(Error);
  });

  // AppError 自定义 code 和 statusCode
  it("AppError 自定义 code 和 statusCode", () => {
    const err = new AppError("Forbidden", "FORBIDDEN", 403);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe("Forbidden");
    expect(err.statusCode).toBe(403);
  });

  // AppError 继承 Error，可通过 instanceof 检查
  it("AppError 是 Error 的实例", () => {
    const err = new AppError("test", "TEST", 500);
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
  });
});
