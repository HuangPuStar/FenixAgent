/**
 * skills.ts — Skill 配置域 API 模块
 *
 * 封装 Skill 的 CRUD 与批量上传操作。
 * 后端使用 RESTful 风格（GET/POST/PUT/DELETE），域模块内部抽象为具名方法。
 * 上传使用 FormData，PUT 上传文件到 Skill 目录。
 */

import type {
  ResourceAccess,
  SkillDetail,
  SkillInfo,
  SkillUploadConflictResponse,
  SkillUploadResponse,
} from "../../src/types/config";
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
  resourceAccess: ResourceAccess;
}

export const skillConfigApi = {
  /** 获取 Skill 列表（GET /config/skills） */
  list: () => request<SkillListResult>("/web/config/skills", { method: "GET" }),

  /** 获取单个 Skill 详情（GET /config/skills/:name） */
  get: (name: string) => request<SkillDetail>("/web/config/skills/:name", { method: "GET", params: { name } }),

  /** 创建 Skill（POST /config/skills），body 为 { name, data: SkillData } */
  create: (name: string, data: SkillData) =>
    request<SkillSaveResult>("/web/config/skills", { method: "POST", body: { name, data } }),

  /** 更新 Skill（PUT /config/skills/:name），body 为 { data: SkillData } */
  update: (name: string, data: SkillData) =>
    request<SkillSaveResult>("/web/config/skills/:name", { method: "PUT", params: { name }, body: { data } }),

  /** 删除 Skill（DELETE /config/skills/:name） */
  del: (name: string) => request<void>("/web/config/skills/:name", { method: "DELETE", params: { name } }),

  /**
   * 下载 Skill 打包文件（GET /config/skills/:name/download）
   *
   * 返回原始 Response（二进制 zip），绕过 JSON 解包，由调用方自行处理下载。
   */
  download: (name: string) =>
    fetch(`/web/config/skills/${encodeURIComponent(name)}/download`, { method: "GET", credentials: "include" }),

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
