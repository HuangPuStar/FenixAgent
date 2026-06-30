/**
 * skills.ts — Skill 配置域 API 模块
 *
 * 封装 Skill 的 CRUD 与批量上传操作。
 * 除 upload 使用 FormData 外，其余采用 POST /web/config/skills 的 action 分发模式，域模块内部抽象为具名方法。
 */

import type { SkillDetail, SkillInfo, SkillUploadConflictResponse, SkillUploadResponse } from "../../src/types/config";
import { request } from "./request";

/** 创建/更新 Skill 所需的 data 载荷 */
export interface SkillData {
  description: string;
  content: string;
  metadata?: Record<string, string>;
  publicReadable?: boolean;
}

/** 列表响应 */
interface SkillListResult {
  skills: SkillInfo[];
}

/** 创建/更新响应 */
interface SkillSaveResult {
  name: string;
}

export const skillApi = {
  /** 获取 Skill 列表 */
  list: () => request<SkillListResult>("/web/config/skills", { method: "POST", body: { action: "list" } }),

  /** 获取单个 Skill 详情 */
  get: (name: string) => request<SkillDetail>("/web/config/skills", { method: "POST", body: { action: "get", name } }),

  /** 创建 Skill */
  create: (name: string, data: SkillData) =>
    request<SkillSaveResult>("/web/config/skills", { method: "POST", body: { action: "create", name, data } }),

  /** 更新 Skill */
  update: (name: string, data: SkillData) =>
    request<SkillSaveResult>("/web/config/skills", { method: "POST", body: { action: "update", name, data } }),

  /** 删除 Skill */
  del: (name: string) => request<void>("/web/config/skills", { method: "POST", body: { action: "delete", name } }),

  /**
   * 批量上传 Skill（FormData 上传）
   *
   * FormData 需包含 manifest（JSON 字符串）和 files（File 数组），可选 conflictStrategy。
   * 存在同名冲突且未传 conflictStrategy 时，后端返回 409 并携带 SkillUploadConflictResponse。
   */
  upload: (formData: FormData) =>
    request<SkillUploadResponse | SkillUploadConflictResponse>("/web/config/skills/upload", {
      method: "POST",
      body: formData,
    }),
};
