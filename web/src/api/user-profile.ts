/**
 * user-profile.ts — 用户资料 API 模块
 *
 * 封装用户个人资料查询、头像上传与删除操作。
 */

import { request } from "./request";

export interface UserProfile {
  name: string;
  email: string;
  image: string | null;
}

export interface AvatarUploadResult {
  image: string;
}

export const userProfileApi = {
  /** 获取当前用户资料 */
  getProfile: () => request<UserProfile>("/web/user/profile", { method: "GET" }),

  /** 上传头像 */
  uploadAvatar: (file: File) => {
    const formData = new FormData();
    formData.append("avatar", file);
    return request<AvatarUploadResult>("/web/user/avatar", {
      method: "POST",
      body: formData,
    });
  },

  /** 删除头像 */
  deleteAvatar: () => request<{ ok: true }>("/web/user/avatar", { method: "DELETE" }),
};
