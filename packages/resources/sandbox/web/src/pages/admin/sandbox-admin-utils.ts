// web/src/pages/admin/sandbox-admin-utils.ts
// 沙盒管理页的纯函数：表单草稿构造与动作结果格式化。
//
// 从原 AdminSandboxPage.tsx 拆出。这些函数不依赖 React，可单测；需要文案时以 `t` 入参
// 注入（而不是在模块内 import i18n 单例），保持「纯函数 + 由调用方决定文案」的边界。

import type { TFunction } from "i18next";

import type { ClusterServer, SandboxPool } from "../../api/system-sandbox";
import { type ClusterActionFeedback, type ClusterServerForm, DEFAULT_SANDBOX_RESOURCES } from "./sandbox-admin-types";

/**
 * 构造资源池表单草稿：无模板时为空白新建，有模板时为「复制」。
 *
 * 复制出的 id 追加 `-copy` 后缀而不是原样带过来——池 id 是主键，原样提交必然冲突；
 * name 由调用方在 UI 上再改。嵌套对象用 structuredClone 深拷贝，避免编辑草稿时
 * 反向污染列表里的原始对象。
 *
 * 名称后缀由调用方经 i18n 注入（用户可见文案不能在纯函数里写死），故 copyNameSuffix 是必填参数。
 */
export function createPoolDraft(template: SandboxPool | undefined, copyNameSuffix: string): SandboxPool {
  const source = template;
  return {
    id: source ? `${source.id}-copy` : "",
    organizationId: source?.organizationId ?? null,
    organizationName: null,
    name: source ? `${source.name}${copyNameSuffix}` : "",
    providerKey: source?.providerKey ?? "opensandbox-cluster",
    image: source?.image ?? "",
    defaultResources: structuredClone(source?.defaultResources ?? DEFAULT_SANDBOX_RESOURCES),
    extra: source?.extra ? structuredClone(source.extra) : null,
    createdAt: "",
    updatedAt: "",
  };
}

/** API 的 Cluster Server → 表单模型（字段名保持 snake_case，提交时直接回传）。 */
export function toClusterServerForm(server: ClusterServer): ClusterServerForm {
  return {
    id: server.id,
    pool_id: server.poolId,
    name: server.name,
    base_url: server.baseUrl,
    workspace_root: server.workspaceRoot,
    max_sandboxes: server.maxSandboxes,
    status: server.status,
    transport_mode: server.transportMode,
  };
}

/**
 * 健康检查返回值 → toast 反馈。
 *
 * 后端返回的 `healthStatus` / `lastError` 是任意 JSON（可能是 4xx 的裸响应），
 * 这里逐字段收窄；拿不到状态时按失败处理（宁可提示异常，也不把「无法判断」当作成功）。
 */
export function formatHealthCheckResult(result: unknown, t: TFunction): ClusterActionFeedback {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { message: t("healthCheckNoStatus"), variant: "error" };
  }
  const payload = result as Record<string, unknown>;
  const healthStatus = payload.healthStatus;
  const lastError = payload.lastError;
  if (typeof healthStatus !== "string") return { message: t("healthCheckNoStatus"), variant: "error" };
  return {
    message:
      typeof lastError === "string" && lastError
        ? t("healthCheckResultWithError", { status: healthStatus, error: lastError })
        : t("healthCheckResult", { status: healthStatus }),
    variant: healthStatus === "healthy" ? "success" : "error",
  };
}
