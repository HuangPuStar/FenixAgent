import { litellmRequest } from "./client";

export interface CreateLitellmUserParams {
  userId: string;
  /** 可选邮箱，LiteLLM 要求非空，无邮箱时生成占位地址 */
  userEmail?: string;
  /** 可选角色，默认 internal_user */
  userRole?: "internal_user" | "internal_user_viewer";
}

export interface LitellmUser {
  user_id: string;
  user_email: string | null;
  user_role: string;
}

/** 在 LiteLLM 中创建用户（幂等：已存在则返回已有用户） */
export async function createLitellmUser(params: CreateLitellmUserParams): Promise<LitellmUser> {
  const email = params.userEmail || `user_${params.userId}@litellm.internal`;

  try {
    return await litellmRequest<LitellmUser>("POST", "/user/new", {
      user_id: params.userId,
      user_email: email,
      user_role: params.userRole || "internal_user",
      auto_create_key: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 用户已存在：删掉再重建，确保邮箱等信息齐全
    if (message.includes("409") || message.includes("already exists")) {
      await litellmRequest("POST", "/user/delete", { user_ids: [params.userId] });
      return litellmRequest<LitellmUser>("POST", "/user/new", {
        user_id: params.userId,
        user_email: email,
        user_role: params.userRole || "internal_user",
        auto_create_key: false,
      });
    }
    throw err;
  }
}
