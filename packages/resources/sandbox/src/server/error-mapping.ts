// src/server/error-mapping.ts
// 远程 Sandbox Cluster 管理动作的 HTTP 错误映射（领域错误 → 状态码 + 稳定错误码）。
//
// 为什么不放在 `routes/`：`sandbox-cluster` 与 `sandbox-server` 两个 route 模块都要用它，
// 落在其中一方会让另一方产生 route → route 依赖边——计划 §1.3(2) 明令禁止（route 只做协议适配，
// 不得调用其他 route；route 间的复用会随切片把协议实现耦合成网状）。映射是协议适配的公共部分，
// 放在 `src/server/` 这一层：下游 route 与上游 service 都不拥有它。
//
// 对外契约：经包根 `@fenix/resource-sandbox/server` 的 `mapSandboxClusterAdminError` 再导出（既有消费者
// 按该名字导入，位置变化不影响其导入路径）。

import { SandboxClusterAdminError, SandboxClusterUnavailableError } from "./services/sandbox-cluster-admin-service";

export function mapSandboxClusterAdminError(error: unknown): {
  status: 400 | 404 | 409 | 503;
  body: { error: { code: string; message: string } };
} {
  if (error instanceof SandboxClusterUnavailableError) {
    return { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: error.message } } };
  }
  if (error instanceof SandboxClusterAdminError) {
    return {
      status: error.status >= 500 ? 503 : error.status === 404 ? 404 : error.status === 409 ? 409 : 400,
      body: { error: { code: error.status === 404 ? "NOT_FOUND" : "CLUSTER_ERROR", message: error.message } },
    };
  }
  return { status: 400, body: { error: { code: "BAD_REQUEST", message: "Cluster request failed" } } };
}
