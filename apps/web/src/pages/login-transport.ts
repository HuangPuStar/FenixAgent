/**
 * login-transport.ts — 登录页的传输适配
 *
 * 登录页只从这里取数与提交（前端规范 §5.1/§5.8）：可用性探测走 `request()`；登录/注册走
 * better-auth 客户端（`@fenix/identity/web`，其 transport 由库自身持有，不经 `request()`）。
 * 页面只消费结果，不拼后端 URL、不写 fetch；服务端错误消息原样回传，i18n 兜底文案由页面决定。
 *
 * `/api/auth/*` 属 better-auth 协议面（非 `{ success, data }` 包装），相关例外登记见
 * docs/developer/guide/frontend-development.md §5.3。
 */

import { authClient, encryptPassword, signUpWithPhone } from "@fenix/identity/web";
import { request } from "@fenix/web-runtime/api/request";
import type { AuthMethod } from "../lib/auth-preference";

/**
 * 查询注册开关 `GET /api/auth/signup-status`。
 *
 * 服务端不可达或响应异常时返回 true（与改动前的 .catch 兜底一致）：探测失败不应把注册入口藏起来。
 */
export async function fetchSignupAllowed(): Promise<boolean> {
  const response = await request<{ signupAllowed?: boolean }>("/api/auth/signup-status");
  if (!response.success) return true;
  return response.data?.signupAllowed === true;
}

/** 一次登录/注册提交所需的表单快照。 */
export interface LoginSubmitInput {
  isSignUp: boolean;
  authMethod: AuthMethod;
  /** 邮箱或手机号，页面已 trim。 */
  identifier: string;
  /** 明文密码，本模块内部负责加密。 */
  password: string;
  /** 注册昵称，为空时按 identifier 兜底。 */
  name: string;
  rememberLogin: boolean;
}

/** 提交结果：失败只带服务端消息（可能为空），页面据此套用 signInFailed / signUpFailed 兜底文案。 */
export type LoginSubmitResult = { ok: true } | { ok: false; message?: string };

/**
 * 加密密码并提交登录/注册。
 *
 * 加密失败与网络异常继续向外抛，由页面统一兜底（与拆分前 handleSubmit 的 try/catch 语义一致）；
 * 认证失败属于正常返回，转成 `{ ok: false }` 交给页面展示。
 */
export async function submitLogin(input: LoginSubmitInput): Promise<LoginSubmitResult> {
  const { isSignUp, authMethod, identifier, password, name, rememberLogin } = input;
  const encPassword = await encryptPassword(password);

  if (isSignUp && authMethod === "phone") {
    const res = await signUpWithPhone({ phoneNumber: identifier, password: encPassword, name: name || identifier });
    return res.error ? { ok: false, message: res.error.message } : { ok: true };
  }

  if (isSignUp) {
    const res = await authClient.signUp.email({
      email: identifier,
      password: encPassword,
      name: name || identifier.split("@")[0],
    });
    return res.error ? { ok: false, message: res.error.message } : { ok: true };
  }

  if (authMethod === "phone") {
    const res = await authClient.signIn.phoneNumber({
      phoneNumber: identifier,
      password: encPassword,
      rememberMe: rememberLogin,
    });
    return res.error ? { ok: false, message: res.error.message } : { ok: true };
  }

  const res = await authClient.signIn.email({ email: identifier, password: encPassword });
  return res.error ? { ok: false, message: res.error.message } : { ok: true };
}
