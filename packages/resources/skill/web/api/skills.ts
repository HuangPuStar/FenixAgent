/**
 * skills.ts — Skill 配置域 API 模块
 *
 * 封装 Skill 的 CRUD 与批量上传操作。
 * 后端使用 RESTful 风格（GET/POST/PUT/DELETE），域模块内部抽象为具名方法。
 * 上传使用 FormData，PUT 上传文件到 Skill 目录。
 */

import { ApiError, request } from "@fenix/web-runtime/api/request";
import type {
  ResourceAccessView,
  SkillDetail,
  SkillInfo,
  SkillUploadConflictResponse,
  SkillUploadResponse,
} from "@fenix/web-runtime/types/config";

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

/** 创建/更新响应：与列表项同一套授权视图，另带归属组织展示名。 */
interface SkillSaveResult extends Partial<ResourceAccessView> {
  name: string;
  organizationName?: string;
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

  /** 仅更新 Skill 的公开读取权限，不修改 SKILL.md 内容。 */
  updateAccess: (name: string, publicReadable: boolean) =>
    request<SkillSaveResult>("/web/config/skills/:name/access", {
      method: "PUT",
      params: { name },
      body: { publicReadable },
    }),

  /** 删除 Skill（DELETE /config/skills/:name） */
  del: (name: string) => request<void>("/web/config/skills/:name", { method: "DELETE", params: { name } }),

  /**
   * 下载 Skill 打包文件（GET /config/skills/:name/download）
   *
   * 返回解包后的 `Blob`，调用方不再接触原始 `Response`，也不必自己做 `ok` 判断。
   *
   * 为什么不走 `request()`：下载端点的成功响应体是二进制 zip，而 `request()` 对非 JSON 响应会先按
   * JSON 试探解析并归一为 `SERVER_ERROR`，字节在这一步就被消费掉，拿不到可下载的内容。失败路径仍接回
   * 统一层：非 2xx 一律抛 `ApiError`，code 取自 `/web/config/*` 的 `{ success, error }` 信封（这样
   * `FORBIDDEN` 这类授权码不会在下载路径上丢失），信封不可用时按状态码兜底。
   *
   * 抛错即契约：调用方必须接住（`useRequest` 的 onError 或 try/catch）。本函数不吞错、也不自己弹提示
   * ——用户可见文案归页面（`t()`）。
   */
  download: async (name: string): Promise<Blob> => {
    const response = await fetch(`/web/config/skills/${encodeURIComponent(name)}/download`, {
      method: "GET",
      credentials: "include",
    });
    if (!response.ok) throw await buildDownloadError(response);
    return response.blob();
  },

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

/**
 * 把下载失败响应归一为统一错误。
 *
 * 错误体是 `/web/config/*` 的 `{ success: false, error: { code, message } }` 信封；被网关/代理拦截时
 * 可能返回 HTML，那时解析会抛错。解析失败不掩盖原始失败：记下响应状态与解析异常作为诊断上下文，
 * 再以状态码兜底（401/403 归 UNAUTHORIZED，其余归 SERVER_ERROR）。兜底刻意保守——未知失败按服务端
 * 错误处理，不会把「凭据失效」误判成「服务异常」或反之。
 */
async function buildDownloadError(response: Response): Promise<ApiError> {
  try {
    const payload = (await response.json()) as { error?: { code?: string; message?: string } };
    if (payload.error?.code) {
      return new ApiError(payload.error.message ?? `请求失败 (${response.status})`, payload.error.code);
    }
  } catch (err) {
    console.error(`[skills] 下载失败响应无法按错误信封解析 (${response.status})`, err);
  }
  const fallbackCode = response.status === 401 || response.status === 403 ? "UNAUTHORIZED" : "SERVER_ERROR";
  return new ApiError(`请求失败 (${response.status})`, fallbackCode);
}
