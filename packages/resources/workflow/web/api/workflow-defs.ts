/**
 * Workflow Definition API Client。
 *
 * 对接后端 RESTful /web/workflow-defs 端点。
 */

// ── 类型定义 ──

export interface WorkflowDefItem {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  description: string | null;
  latestVersion: number | null;
  storagePath: string | null;
  createdAt: string;
  updatedAt: string;
  draftYaml?: string | null;
}

export interface WorkflowVersionItem {
  id: string;
  workflowId: string;
  version: number;
  filePath: string;
  status: string;
  createdBy: string;
  createdAt: string;
}

export interface VersionYamlResponse {
  workflowId: string;
  version: number;
  yaml: string;
}

export interface TriggerItem {
  id: string;
  workflowId: string;
  type: string;
  publicHash: string;
  maskedHash: string;
  webhookUrl: string | null;
  secret: string | null;
  config: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowParamDefsResponse {
  version: number;
  params: Record<string, unknown>;
}

export interface CustomToolInputDef {
  type: string;
  required?: boolean;
  description: string;
  group?: string;
}

export interface CustomToolItem {
  name: string;
  description: string;
  inputs: Record<string, CustomToolInputDef>;
  produces: string[];
  kind?: string;
  color?: string;
  env?: string[];
}

// ── API Client ──

import type { ApiResponse } from "@fenix/web-runtime/api/request";
import { request } from "@fenix/web-runtime/api/request";

const ENDPOINT = "/web/workflow-defs";

/**
 * 可取消调用的选项。
 *
 * §3.4 规定主动取消走 `request()` 的 `signal`，而不是靠 `useRequest` 的并发语义兜底：组件持有
 * `AbortController`，换工作流 / 换组织 / 卸载时 abort。省略时与不传完全一致（`request()` 内部
 * 仍按自己的超时信号工作），故既有调用点不受影响。
 */
export interface WorkflowRequestOptions {
  /** 外部取消信号：与 `request()` 内部的超时信号合并，任一 abort 都会终止在途请求。 */
  signal?: AbortSignal;
}

// ── API Methods ──

export const workflowDefApi = {
  /** 列出工作流 */
  list: (options?: WorkflowRequestOptions) =>
    request<WorkflowDefItem[]>(ENDPOINT, { method: "GET", signal: options?.signal }),

  /** 创建工作流 */
  create: (name: string, description?: string) =>
    request<WorkflowDefItem>(ENDPOINT, { method: "POST", body: { name, description } }),

  /** 获取单个工作流（含草稿内容） */
  get: (workflowId: string, options?: WorkflowRequestOptions) =>
    request<WorkflowDefItem>(`${ENDPOINT}/${workflowId}`, { method: "GET", signal: options?.signal }),

  /** 保存草稿 */
  save: (workflowId: string, yaml: string) =>
    request<void>(`${ENDPOINT}/${workflowId}/draft`, { method: "PUT", body: { yaml } }),

  /** 发布版本 */
  publish: (workflowId: string) =>
    request<WorkflowVersionItem>(`${ENDPOINT}/${workflowId}/publish`, { method: "POST" }),

  /** 删除工作流 */
  delete: (workflowId: string) => request<void>(`${ENDPOINT}/${workflowId}`, { method: "DELETE" }),

  /** 更新元数据 */
  updateMeta: (workflowId: string, data: { name?: string; description?: string }) =>
    request<WorkflowDefItem>(`${ENDPOINT}/${workflowId}`, { method: "PATCH", body: data }),

  /** 获取版本历史 */
  getVersions: (workflowId: string, options?: WorkflowRequestOptions) =>
    request<WorkflowVersionItem[]>(`${ENDPOINT}/${workflowId}/versions`, {
      method: "GET",
      signal: options?.signal,
    }),

  /** 获取特定版本 YAML */
  getVersion: (workflowId: string, version: number) =>
    request<VersionYamlResponse>(`${ENDPOINT}/${workflowId}/versions/${version}`, { method: "GET" }),

  /** 设置 latest 指针（回滚） */
  setLatest: (workflowId: string, version: number) =>
    request<void>(`${ENDPOINT}/${workflowId}/versions/${version}/set-latest`, { method: "POST" }),

  /** 恢复版本到草稿 */
  restoreToDraft: (workflowId: string, version: number) =>
    request<void>(`${ENDPOINT}/${workflowId}/versions/${version}/restore`, { method: "POST" }),

  /** 获取工作流参数定义（从 YAML 解析） */
  getParamDefs: (workflowId: string, version?: number) =>
    request<WorkflowParamDefsResponse>(`${ENDPOINT}/${workflowId}/params`, {
      method: "GET",
      query: version !== undefined ? { version: String(version) } : undefined,
    }),

  /** 扫描可恢复的工作流 ID */
  recover: () => request<string[]>(`${ENDPOINT}/recoverable`, { method: "GET" }),

  /** 执行恢复 */
  recoverApply: (workflowIds: string[]) =>
    request<WorkflowDefItem[]>(`${ENDPOINT}/recover`, { method: "POST", body: { workflowIds } }),

  // ── Triggers ──

  /** 创建 webhook trigger */
  createTrigger: (workflowId: string, type?: string, config?: Record<string, unknown>) =>
    request<TriggerItem>(`${ENDPOINT}/${workflowId}/triggers`, {
      method: "POST",
      body: { type, config },
    }),

  /** 列出 workflow 的所有 trigger */
  listTriggers: (workflowId: string, options?: WorkflowRequestOptions) =>
    request<TriggerItem[]>(`${ENDPOINT}/${workflowId}/triggers`, { method: "GET", signal: options?.signal }),

  /** 删除 trigger */
  deleteTrigger: (workflowId: string, triggerId: string) =>
    request<void>(`${ENDPOINT}/${workflowId}/triggers/${triggerId}`, { method: "DELETE" }),

  /** 重新生成 hash */
  regenerateTriggerHash: (workflowId: string, triggerId: string) =>
    request<TriggerItem>(`${ENDPOINT}/${workflowId}/triggers/${triggerId}/regenerate`, { method: "POST" }),

  /** 启用 trigger */
  enableTrigger: (workflowId: string, triggerId: string) =>
    request<void>(`${ENDPOINT}/${workflowId}/triggers/${triggerId}/enable`, { method: "POST" }),

  /** 禁用 trigger */
  disableTrigger: (workflowId: string, triggerId: string) =>
    request<void>(`${ENDPOINT}/${workflowId}/triggers/${triggerId}/disable`, { method: "POST" }),
};

export const customToolsApi = {
  /**
   * 列出已注册的 custom 工具。
   *
   * 走统一 `request()` 并返回 `ApiResponse`，由消费方 `unwrap()` 解包（§5.4：解包归属不由域模块代劳）。
   * 失败（HTTP / 业务 / 网络）由 `request()` 表达成 `{ success: false }`，`unwrap()` 会抛 `ApiError`——
   * 不再像手写解析时代那样压成 `[]`（「失败映射成 empty」是在途项 25 点名的缺陷形态，消费方需要能分辨
   * 失败与「没有 custom 工具」）。
   *
   * **数组形状防御**：列表端点缺 `data` 字段时，`request()` 会把**整个信封**当 data 透出（`request.ts`
   * 的 `"data" in json` 规则，即 §5.3 记的「无 `data` 字段时整包即 `data`」），而本方法的签名承诺
   * `CustomToolItem[]`——消费方 `setToolColors()` 的 `for (const t of tools)` 会在渲染期抛 TypeError。
   * 这里只兜「成功但形状不对」：成功信封里的非数组收敛成空列表；失败分支原样返回，仍由 `unwrap()` 抛错。
   * 收紧点选在域模块而非各消费点，是因为本方法是 `./web` 出口的公开 API——签名可信之后，每个消费方
   * 各写一遍形状判断才是真正的重复。
   */
  list: async (): Promise<ApiResponse<CustomToolItem[]>> => {
    const result = await request<CustomToolItem[]>("/web/workflow-custom-tools", { method: "GET" });
    if (!result.success) return result;
    return { success: true, data: Array.isArray(result.data) ? result.data : [] };
  },
};
