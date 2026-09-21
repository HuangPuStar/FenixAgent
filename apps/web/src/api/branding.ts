/**
 * branding.ts -- 品牌配置域 API 模块
 *
 * 封装品牌配置的读取操作，统一通过 request() 与后端通信。
 *
 * 迁移自 `packages/resources/identity-admin/web/api/branding.ts`：品牌配置属于控制台壳展示职责而非身份
 * 职责（CE/EE 重构决策 D4），随身份包拆分落位到 `apps/web` 宿主。请求路径与返回类型保持不变。
 */

import { request } from "@fenix/web-runtime/api/request";

/** 品牌配置数据 */
export interface BrandingConfig {
  brandName: string;
  logoUrl: string | null;
}

export const brandingApi = {
  /** 获取当前系统展示使用的品牌名称和 Logo 地址配置 */
  get: () => request<BrandingConfig>("/web/branding", { method: "GET" }),
};
