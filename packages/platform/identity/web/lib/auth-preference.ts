export const AUTH_PREFERRED_METHOD_STORAGE_KEY = "auth-preferred-method";

export type AuthMethod = "email" | "phone";

/** 读取上次使用的登录方式；异常时默认回退到邮箱。 */
export function getPreferredAuthMethod(): AuthMethod {
  try {
    const stored = localStorage.getItem(AUTH_PREFERRED_METHOD_STORAGE_KEY);
    return stored === "phone" ? "phone" : "email";
  } catch {
    return "email";
  }
}

/** 持久化登录方式偏好，便于手机号用户下次直达对应 tab。 */
export function setPreferredAuthMethod(method: AuthMethod): void {
  try {
    localStorage.setItem(AUTH_PREFERRED_METHOD_STORAGE_KEY, method);
  } catch {
    // 忽略浏览器存储异常，避免影响主流程。
  }
}
