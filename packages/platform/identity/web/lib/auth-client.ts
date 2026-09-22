import { apiKeyClient } from "@better-auth/api-key/client";
import { organizationClient, phoneNumberClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: "", // same origin
  plugins: [organizationClient(), phoneNumberClient(), apiKeyClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;

/**
 * 手机号注册：`POST /api/auth/sign-up/phone` 是宿主 auth 插件在 better-auth 挂载前缀下自定义的路由
 * （内部改写为 sign-up/email），**没有**对应的 better-auth 客户端方法，因此这里保留手写请求。
 *
 * 不走 `request()` 的原因（前端规范 §5.3 例外登记）：该路由成功时返回 better-auth 的代理响应体、
 * 失败时返回顶层 `{ code, message }`（如 PHONE_NUMBER_EXISTS），而 `request()` 只识别
 * `{ success, data }` 包装与 `error.{code,message}`，改写后错误文案会退化成「请求失败 (4xx)」——
 * 属用户可见回归。补 `request()` 顶层 message/code 能力（need-to-change 25）后再收口。
 */
export async function signUpWithPhone(body: { name: string; phoneNumber: string; password: string }) {
  const response = await fetch("/api/auth/sign-up/phone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });

  let json: Record<string, unknown> | null = null;
  try {
    json = (await response.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message =
      (json?.message as string | undefined) || (json?.error as { message?: string } | undefined)?.message || "注册失败";
    return { data: null, error: { message, status: response.status } };
  }

  return { data: json, error: null };
}
