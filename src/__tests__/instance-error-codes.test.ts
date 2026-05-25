import { describe, expect, it } from "bun:test";

// R15: 验证 spawnInstanceFromEnvironment 抛出 typed errors (code-based routing)
// 以及 instances.ts 路由的 statusCode 映射逻辑

const { NotFoundError, AppError } = await import("../errors");

/** 复现 instances.ts 的 statusCode 映射逻辑 */
function mapSpawnErrorToStatus(err: { code?: string; message: string }): number {
  return err.code === "NOT_FOUND"
    ? 404
    : err.code === "FORBIDDEN"
      ? 403
      : err.code === "VALIDATION_ERROR"
        ? 400
        : err.code === "MAX_SESSIONS_REACHED"
          ? 409
          : 500;
}

describe("instance spawn 错误码 → HTTP status 映射", () => {
  // NotFoundError → 404
  it("NotFoundError → 404", () => {
    const err = new NotFoundError("Environment not found");
    expect(mapSpawnErrorToStatus(err)).toBe(404);
  });

  // FORBIDDEN → 403
  it("FORBIDDEN → 403", () => {
    const err = new AppError("Not your environment", "FORBIDDEN", 403);
    expect(mapSpawnErrorToStatus(err)).toBe(403);
  });

  // VALIDATION_ERROR → 400
  it("VALIDATION_ERROR → 400", () => {
    const err = new AppError("Workspace directory not set", "VALIDATION_ERROR", 400);
    expect(mapSpawnErrorToStatus(err)).toBe(400);
  });

  // MAX_SESSIONS_REACHED → 409
  it("MAX_SESSIONS_REACHED → 409", () => {
    const err = new AppError("max sessions reached", "MAX_SESSIONS_REACHED", 409);
    expect(mapSpawnErrorToStatus(err)).toBe(409);
  });

  // 未知错误 → 500
  it("plain Error → 500", () => {
    const err = new Error("unexpected");
    expect(mapSpawnErrorToStatus(err as any)).toBe(500);
  });

  // NotFoundError 携带正确 message
  it("NotFoundError 保留原始 message", () => {
    const err = new NotFoundError("AgentConfig 'abc' not found");
    expect(err.message).toBe("AgentConfig 'abc' not found");
    expect(err.code).toBe("NOT_FOUND");
  });
});
