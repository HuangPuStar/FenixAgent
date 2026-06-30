/**
 * models.ts — Model 配置域 API 模块
 *
 * 封装当前使用的模型配置的读取与更新操作。
 * 后端使用 POST /web/config/models 的 action 分发模式，域模块内部抽象为具名方法。
 */

import type { ModelConfig } from "../../src/types/config";
import { request } from "./request";

export const modelApi = {
  /** 获取当前模型配置 */
  get: () => request<ModelConfig>("/web/config/models", { method: "POST", body: { action: "get" } }),

  /** 更新模型配置 */
  set: (data: ModelConfig) =>
    request<ModelConfig>("/web/config/models", { method: "POST", body: { action: "set", data } }),

  /** 刷新可用模型列表 */
  refresh: () => request<ModelConfig>("/web/config/models", { method: "POST", body: { action: "refresh" } }),
};
