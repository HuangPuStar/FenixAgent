/**
 * branding.ts -- 品牌配置域 API 模块
 *
 * 封装品牌配置的读取操作，统一通过 request() 与后端通信。
 */

import { request } from "./request";

/** 品牌配置数据 */
export interface BrandingConfig {
  brandName: string;
  logoUrl: string | null;
}

export const brandingApi = {
  /** 获取当前系统展示使用的品牌名称和 Logo 地址配置 */
  get: () => request<BrandingConfig>("/web/branding", { method: "GET" }),
};
