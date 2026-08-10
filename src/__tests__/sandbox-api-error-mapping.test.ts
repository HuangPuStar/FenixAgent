import { describe, expect, test } from "bun:test";
import { SandboxProviderError } from "@fenix/sandbox-provider";
import { mapSandboxApiError } from "../routes/api/sandbox";
import { SandboxProviderNotConfiguredError } from "../services/sandbox/sandbox-errors";

describe("sandbox API error mapping", () => {
  // Pool 唯一约束冲突必须转换为资源冲突，而不是通用参数错误。
  test("maps PostgreSQL unique constraint errors to HTTP 409", () => {
    const error = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    expect(mapSandboxApiError(error)).toEqual({
      status: 409,
      body: { error: { code: "CONFLICT", message: "duplicate key value violates unique constraint" } },
    });
  });

  // Provider 未注册时必须返回服务不可用，而不是参数错误。
  test("maps an unconfigured provider to HTTP 503", () => {
    expect(mapSandboxApiError(new SandboxProviderNotConfiguredError("opensandbox-cluster"))).toEqual({
      status: 503,
      body: {
        error: { code: "SERVICE_UNAVAILABLE", message: "sandbox provider 'opensandbox-cluster' is not configured" },
      },
    });
  });

  // Provider 的远程服务错误应保留为网关/服务不可用错误。
  test("maps provider unavailable errors to HTTP 503", () => {
    const error = new SandboxProviderError("cluster unavailable", "UNAVAILABLE", true);
    expect(mapSandboxApiError(error)).toEqual({
      status: 503,
      body: { error: { code: "SERVICE_UNAVAILABLE", message: "cluster unavailable" } },
    });
  });
});
