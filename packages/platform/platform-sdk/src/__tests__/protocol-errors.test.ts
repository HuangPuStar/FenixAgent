import { describe, expect, test } from "bun:test";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../protocol/errors";

/**
 * 跨包错误分类法的对外契约：错误码与默认 HTTP 状态是宿主全局错误处理器映射响应的唯一依据
 * （`apps/server/src/plugins/error-handler.ts` 按 `instanceof AppError` 取值），因此码值变更属于
 * 破坏性变更，必须在用例里钉住。
 */
describe("AppError 分类法", () => {
  // 各子类的 code / statusCode 是对外协议，改动会让调用方的分支判断失效。
  test("子类携带稳定错误码与默认 HTTP 状态", () => {
    expect(new ValidationError("参数不合法")).toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    expect(new NotFoundError("不存在")).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(new ForbiddenError("无权访问")).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    // ALREADY_EXISTS 是历史错误码，改名会破坏既有调用方
    expect(new ConflictError("已存在")).toMatchObject({ code: "ALREADY_EXISTS", statusCode: 409 });
  });

  // 宿主按 instanceof 映射状态：子类必须真实继承，跨包抛出后 instanceof 才成立。
  test("子类均为 AppError 与 Error 的实例", () => {
    for (const error of [
      new ValidationError("参数不合法"),
      new NotFoundError("不存在"),
      new ForbiddenError("无权访问"),
      new ConflictError("已存在"),
    ]) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  // 基类允许自定义码与状态（编排域、限流等由调用方决定语义），默认状态为 500。
  test("基类支持自定义码并默认 500", () => {
    expect(new AppError("限流", "RATE_LIMITED", 429)).toMatchObject({ code: "RATE_LIMITED", statusCode: 429 });
    expect(new AppError("内部错误", "INTERNAL")).toMatchObject({ code: "INTERNAL", statusCode: 500 });
  });
});
