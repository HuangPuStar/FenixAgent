/**
 * ragflow-key.ts — RAGFlow API Key 管理 API 模块
 *
 * 封装用户级和组织级 RAGFlow API Key 的 CRUD 操作。
 */

import { request } from "./request";

export interface RagflowKeyStatus {
  configured: boolean;
  prefix: string | null;
}

export const ragflowKeyApi = {
  /** 获取当前用户 RAGFlow key 状态 */
  getUserStatus: () => request<RagflowKeyStatus>("/web/user/ragflow-key", { method: "GET" }),

  /** 保存当前用户 RAGFlow key */
  saveUserKey: (ragflowApiKey: string) =>
    request<{ ok: true }>("/web/user/ragflow-key", {
      method: "POST",
      body: { ragflowApiKey },
    }),

  /** 删除当前用户 RAGFlow key */
  deleteUserKey: () => request<{ ok: true }>("/web/user/ragflow-key", { method: "DELETE" }),
};
