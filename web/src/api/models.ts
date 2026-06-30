/**
 * models.ts — Model 配置域 API 模块
 *
 * 封装当前使用的模型配置的读取与更新操作。
 * 后端使用 POST /web/config/models 的 action 分发模式，域模块内部抽象为具名方法。
 */

import type { ModelConfig, PermissionConfig } from "../../src/types/config";
import { request } from "./request";

export const modelApi = {
  /** 获取当前模型配置 */
  get: () => request<ModelConfig>("/web/config/models", { method: "POST", body: { action: "get" } }),

  /**
   * 更新模型配置
   * 后端只接受平级字段 { model?, small_model?, permission? }，返回平级对象。
   */
  set: (data: { model?: string; small_model?: string; permission?: PermissionConfig }) =>
    request<{ model: string | null; small_model: string | null; permission: PermissionConfig | null }>(
      "/web/config/models",
      { method: "POST", body: { action: "set", data } },
    ),

  /** 刷新可用模型列表，后端返回 { count } */
  refresh: () => request<{ count: number }>("/web/config/models", { method: "POST", body: { action: "refresh" } }),
};
