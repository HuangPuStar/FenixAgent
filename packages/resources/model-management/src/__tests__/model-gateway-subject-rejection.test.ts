import { describe, expect, test } from "bun:test";
import { AppError } from "@fenix/platform-sdk";
import { toSubjectRejectionError } from "../server/model-gateway/subject-rejection";

/**
 * 主体复验失败的 HTTP 映射回归。
 *
 * 这条判定曾以裸 `Error` 抛出，被入口兜底成 500「配置写入失败」：用户看到的不是"共享已被收回"，
 * 而是服务故障。拒绝原因必须保留为可区分的 4xx 错误码。
 */

describe("主体复验失败映射", () => {
  // Agent 行已不存在是资源消失，按 404 返回，调用方据此提示"Agent 不存在"。
  test("AGENT_NOT_FOUND 映射为 404", () => {
    const error = toSubjectRejectionError("AGENT_NOT_FOUND");

    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe("AGENT_NOT_FOUND");
    expect(error.message).toBe("agent not found");
  });

  // 其余原因都是"当前主体无权使用"，统一按 403 返回，不能落成 500。
  test.each([
    "USER_NOT_FOUND",
    "ORGANIZATION_NOT_FOUND",
    "MEMBERSHIP_NOT_FOUND",
    "AGENT_ACCESS_REVOKED",
  ] as const)("%s 映射为 403 AGENT_ACCESS_DENIED", (reason) => {
    const error = toSubjectRejectionError(reason);

    expect(error).toBeInstanceOf(AppError);
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe("AGENT_ACCESS_DENIED");
  });
});
