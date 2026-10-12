/**
 * 工单操作账本域模块（`GET /web/ticket-operations/:operationId`）。
 *
 * 这是 202 之后「核对结果」按钮的唯一取数入口：一次写操作的结果由账本行自己给出，前端**不轮询**、
 * 不做本地推断（T02 决策 D3）。可见性由服务端判定——非本人发起与不存在同形返回 404。
 *
 * 类型逐字段对应后端 `TicketOperationViewSchema`（本包 `src/schemas/ticket-operation.schema.ts`，
 * T02 已实现，T03 只是扩了 `kind` 与 `status` 的取值集合）。两处刻意的建模口径：
 * - `kind` 按 `string` 建模（后端是枚举）：前端**不按 kind 分支**，新增一种操作不该变成前端的类型改动；
 * - `projectId` 虽不在界面文案里，但它是账本行真实字段（开通项目在成功前没有项目行，故可空），
 *   类型如实建模，避免「前端类型比后端少一个字段」在排障时把线索截断。
 *
 * 域模块不做 `unwrap`，失败处理留给调用方的 `useRequest`；「核对结果」的失败只影响横幅内的一小块，
 * 不改变页面主状态。
 */

import type { ApiResponse } from "@fenix/web-runtime/api/request";
import { request } from "@fenix/web-runtime/api/request";

/** 操作状态；取值与 `ticket_operations.status` 一一对应，本批随在途互斥扩到 `needs_review`。 */
export type TicketOperationStatus = "pending" | "dispatching" | "succeeded" | "failed" | "uncertain" | "needs_review";

/** 账本行视图：`result` 是不定型摘要（其形状随 kind 变化，前端不解析内部字段）。 */
export interface TicketOperationView {
  operationId: string;
  kind: string;
  status: TicketOperationStatus;
  projectId: string | null;
  /** 远端对象 ID（工单为 issue number、评论为评论 ID），按字符串承载。 */
  targetId: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export const ticketOperationsApi = {
  /** 按 operationId 取一次写操作的账本行；非本人或不存在都是 404（同形，不可据此区分）。 */
  get: async (operationId: string): Promise<ApiResponse<TicketOperationView>> => {
    const response = await request<{ operation: TicketOperationView }>("/web/ticket-operations/:operationId", {
      params: { operationId },
    });
    if (!response.success || response.data === undefined) return { success: false, error: response.error };
    return { success: true, data: response.data.operation };
  },
};
