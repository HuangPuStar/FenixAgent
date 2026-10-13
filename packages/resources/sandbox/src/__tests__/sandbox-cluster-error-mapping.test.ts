// packages/resources/sandbox/src/__tests__/sandbox-cluster-error-mapping.test.ts
// Cluster / Sandbox Server 协议面的错误映射契约测试。
//
// 单独成文件的理由：`mapSandboxClusterAdminError` 原先定义在 route 模块内，为切断 §1.3(2) 禁止的
// route → route 依赖边，实现已移入 `src/server/error-mapping.ts`。本文件从**包根入口** `./server` 导入，
// 同时钉住两件事：映射语义未因搬迁改变，且既有公开导入路径（包根再导出）仍然成立。
//
// 与 `sandbox-api-error-mapping.test.ts` 的分工：那个文件测 `/api/system/sandbox-pools` 面的
// `mapSandboxApiError`，本文件只测 Cluster / Sandbox Server 面，两者不合并以免断言互相牵制。

import { describe, expect, test } from "bun:test";
import {
  mapSandboxClusterAdminError,
  SandboxClusterAdminError,
  SandboxClusterUnavailableError,
} from "@fenix/resource-sandbox/server";

describe("sandbox cluster admin error mapping", () => {
  // Cluster 整体不可达是外部依赖故障，必须给出 503：调用方据此提示「稍后重试」而非「请求有误」。
  test("maps an unavailable cluster to HTTP 503", () => {
    expect(mapSandboxClusterAdminError(new SandboxClusterUnavailableError())).toEqual({
      status: 503,
      body: { error: { code: "SERVICE_UNAVAILABLE", message: "Sandbox Cluster service is unavailable" } },
    });
  });

  // 上游 404 必须保留「资源不存在」语义；压平成 400 会让前端无法区分「写错 ID」与「参数非法」。
  test("maps an upstream 404 to HTTP 404 NOT_FOUND", () => {
    expect(mapSandboxClusterAdminError(new SandboxClusterAdminError(404, "pool not found"))).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "pool not found" } },
    });
  });

  // 唯一约束冲突等上游 409 要透传为资源冲突，前端才能提示「名称已存在」而不是通用错误。
  test("maps an upstream 409 to HTTP 409", () => {
    expect(mapSandboxClusterAdminError(new SandboxClusterAdminError(409, "pool already exists"))).toEqual({
      status: 409,
      body: { error: { code: "CLUSTER_ERROR", message: "pool already exists" } },
    });
  });

  // 上游 5xx 对调用方是服务不可用：直接透传 5xx 会把上游状态码与故障面暴露给 /api/system 调用方。
  test("maps an upstream 5xx to HTTP 503", () => {
    expect(mapSandboxClusterAdminError(new SandboxClusterAdminError(500, "cluster internal error")).status).toBe(503);
  });

  // 非本域异常（如未预期的 TypeError）不得透传自身 message，统一通用文案，避免内部实现细节外泄。
  test("maps unknown errors to a generic HTTP 400", () => {
    expect(mapSandboxClusterAdminError(new TypeError("cannot read properties of undefined"))).toEqual({
      status: 400,
      body: { error: { code: "BAD_REQUEST", message: "Cluster request failed" } },
    });
  });
});
