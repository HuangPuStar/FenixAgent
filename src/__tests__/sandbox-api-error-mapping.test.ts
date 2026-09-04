import { describe, expect, test } from "bun:test";
import { SandboxProviderError } from "@fenix/sandbox-provider";
import { mapSandboxApiError } from "../routes/api/sandbox";
import { SandboxProviderNotConfiguredError, SandboxRuntimeNotReadyError } from "../services/sandbox/sandbox-errors";

describe("sandbox API error mapping", () => {
  // Pool 唯一约束冲突必须转换为资源冲突，而不是通用参数错误。
  test("maps PostgreSQL unique constraint errors to HTTP 409", () => {
    const error = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
    expect(mapSandboxApiError(error)).toEqual({
      status: 409,
      body: { error: { code: "CONFLICT", message: "duplicate key value violates unique constraint" } },
    });
  });

  // Service 层提前发现重复 Pool ID 时，API 仍必须返回明确的资源冲突。
  test("maps service-level duplicate pool errors to HTTP 409", () => {
    expect(mapSandboxApiError(new Error("sandbox pool 'pool-1' already exists"))).toEqual({
      status: 409,
      body: { error: { code: "CONFLICT", message: "sandbox pool 'pool-1' already exists" } },
    });
  });

  // Provider 未注册时必须返回服务不可用，而不是参数错误；message 固定通用文案，
  // 不得透传 providerKey（ProviderNotConfiguredError 携带内部标识，泄漏给
  // /api/system 调用方属敏感信息外泄）
  test("maps an unconfigured provider to HTTP 503", () => {
    const mapped = mapSandboxApiError(new SandboxProviderNotConfiguredError("opensandbox-cluster"));

    expect(mapped).toEqual({
      status: 503,
      body: { error: { code: "SERVICE_UNAVAILABLE", message: "Sandbox service is unavailable" } },
    });
    expect(JSON.stringify(mapped)).not.toContain("opensandbox-cluster");
  });

  // Sandbox Runtime 未就绪同样返回 503；message 固定文案，不得泄漏 sbi_* sandboxId
  test("maps a runtime-not-ready error to HTTP 503", () => {
    const mapped = mapSandboxApiError(new SandboxRuntimeNotReadyError("sbi_secret_sandbox_1"));

    expect(mapped).toEqual({
      status: 503,
      body: { error: { code: "SERVICE_UNAVAILABLE", message: "Sandbox service is unavailable" } },
    });
    expect(JSON.stringify(mapped)).not.toContain("sbi_secret_sandbox_1");
  });

  // Provider 的远程服务错误必须分类映射并脱敏，不能泄漏集群诊断内容。
  test("maps provider unavailable errors to a sanitized HTTP 503", () => {
    const error = new SandboxProviderError("cluster unavailable at https://internal.example", "UNAVAILABLE", true);
    const mapped = mapSandboxApiError(error);
    expect(mapped).toEqual({
      status: 503,
      body: { error: { code: "SERVICE_UNAVAILABLE", message: "Sandbox service is unavailable" } },
    });
    expect(JSON.stringify(mapped)).not.toContain("internal.example");
  });
});
