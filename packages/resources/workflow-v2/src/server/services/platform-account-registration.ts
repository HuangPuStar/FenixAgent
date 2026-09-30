/**
 * 平台上游账号的**自助注册**：账号不存在时由引导流程现场建号，部署方不再需要人工建号。
 *
 * 为什么自带一次裸 POST 而不复用 `upstream-client`：注册与登录同属 passport 家族，是上游 `SessionAuthMW` 白名单里
 * **仅有的两条免 cookie 路径**；而 `callUpstream()` 会先 `ensureCookie()`，账号不存在时它会先失败在登录上，永远走不到
 * 注册。因此这里的 fetch、超时与业务码读法与 `upstream-session` 的登录请求保持一致（同一个上游面，同一种诊断口径）。
 *
 * 调用边界（**只允许引导/首启路径调用**）：唯一调用方是 `platform-account-bootstrap.ts`，且只在台账无行、需要现场
 * 确定账号身份时到达。常规登录失败路径（`upstream-client` 的鉴权失败分支、`upstream-session.login()`）不得触达本文件——
 * 那会把「env 里邮箱写错」这类配置错误变成凭空建出的垃圾账号。
 *
 * 幂等：上游对已存在的邮箱返回 `700000001`（`errno.ErrUserEmailAlreadyExistCode`），本文件把它归一为
 * {@link PlatformAccountRegistrationOutcome} 的 `already_exists` 这一**正常结果**，因此**顺次**重复执行的「确保账号
 * 存在」是幂等的。但幂等是**我方的收敛口径，不是上游的保证**：上游注册是「先 `CheckEmailExist` 再插入」，没有事务
 * 也没有锁（`user_impl.go:252-259`），两个副本真正同时首启时两个请求都可能通过查重，后插入的那个会撞上
 * `user.uniq_email` 唯一索引（见 `docker/volumes/mysql/schema.sql` 的 user 表）：上游对这条冲突不给可识别的业务码，
 * 以 HTTP 500（`{code:500}`）兜底，本文件只能归为 `failed`。此时账号已被另一个副本建出，随后的登录照常成功，
 * 引导**不因此失败**（只多一条告警日志），也不会产生第二个账号。
 *
 * 上游禁用注册时返回 `700000008`（`ErrNotAllowedRegisterCode`）；不要依赖 `ALLOW_REGISTRATION_EMAIL` 白名单——
 * 上游把该白名单读成了 `DISABLE_USER_REGISTRATION`，开关一开白名单必然失效。
 *
 * 凭据边界：请求体含密码（只进出站请求，绝不进日志、错误文案与返回值）；注册响应会 `Set-Cookie` 一个
 * `session_key`（上游注册内部顺带完成了一次登录），本文件**不读取也不采纳**它——会话只能由 `upstream-session` 持有，
 * 否则同一次引导会出现第二条持有登录态的路径；何况上游按用户只存一个 session_key，这份马上会被随后的登录覆盖。
 */

import { getWorkflowV2Config } from "../config";
import { PLATFORM_ACCOUNT_LOCALE_ZH } from "./platform-account-locale";

/** 注册端点；body 只需 `{email, password}`（上游 `passport.PassportWebEmailRegisterV2PostRequest`）。 */
const REGISTER_PATH = "/api/passport/web/email/register/v2/";

/** 邮箱已存在（上游 `errno.ErrUserEmailAlreadyExistCode`，`backend/types/errno/user.go:27`）——幂等判定的唯一依据。 */
export const UPSTREAM_EMAIL_ALREADY_EXISTS_CODE = 700000001;

/** 上游禁止注册（`errno.ErrNotAllowedRegisterCode`，`backend/types/errno/user.go:34`，由 `DISABLE_USER_REGISTRATION` 控制）。 */
export const UPSTREAM_REGISTRATION_DISABLED_CODE = 700000008;

/**
 * 注册结果四态。
 *
 * - `created` / `already_exists`：账号已可用，调用方继续走原有登录链路；
 * - `registration_disabled`：上游关闭了注册，本期部署无法自助建号；
 * - `failed`：未知业务码、非预期 HTTP 状态或请求本身未完成（超时 / 网络）。
 *
 * 后两态**不等于**引导失败：账号可能是人工建的，注册不可用不影响登录。因此调用方先按它们记诊断，只有随后的登录
 * 也失败时才拿它们定性最终原因（见 `platform-account-bootstrap` 的 `describeLoginFailure`）。
 */
export type PlatformAccountRegistrationOutcome =
  | { readonly kind: "created" }
  | { readonly kind: "already_exists" }
  | { readonly kind: "registration_disabled"; readonly upstreamCode: number }
  /** `detail` 沿用会话模块的失败标签写法（`code=...` / `http=...` / `timeout` / `network`），不含凭据。 */
  | { readonly kind: "failed"; readonly detail: string; readonly cause?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBusinessCode(payload: unknown): number | undefined {
  if (!isRecord(payload)) return;
  return typeof payload.code === "number" ? payload.code : undefined;
}

/** JSON 解析失败返回 null：注册只关心业务码，响应不是 JSON 时按「未成功」处理。 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 尝试为配置里的账号邮箱注册一次（幂等：邮箱已存在按成功处理）。
 *
 * 不抛错：四种结果都由返回值表达，调用方要先记诊断、再决定是否把它当作最终失败（见结果类型注释）。失败时保留
 * 底层 `cause` 供调用方挂进错误链；响应正文只用来读业务码，其内容（可能含邮箱）不进诊断，`Set-Cookie` 则整条不读。
 */
export async function registerPlatformAccount(): Promise<PlatformAccountRegistrationOutcome> {
  const config = getWorkflowV2Config();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.upstreamTimeoutMs);

  try {
    const response = await fetch(`${config.upstreamBaseUrl.replace(/\/+$/, "")}${REGISTER_PATH}`, {
      method: "POST",
      // `Accept-Language` 决定新账号的 `locale`（内嵌画布的语言，见 `platform-account-locale`）：上游注册在
      // 免 cookie 路径上取 `I18nMW` 回填的 `Accept-Language`（只取第一段，不去 q 值），缺失时默认 `en-US`
      // ——不带头就等于把账号建成了英文。固定写 zh-CN 而不是跟随部署环境：画布语言是我方的产品要求。
      headers: { "Content-Type": "application/json", "Accept-Language": PLATFORM_ACCOUNT_LOCALE_ZH },
      // 密码只出现在这里；本函数的返回值与诊断标签一律不含它。
      body: JSON.stringify({ email: config.accountEmail, password: config.accountPassword }),
      signal: controller.signal,
    });
    const code = readBusinessCode(safeJson(await response.text()));

    // 业务码优先于 HTTP 状态：上游的业务错误一律以 HTTP 200 + 非零 code 下发（`httputil.InternalError`）。
    if (code === UPSTREAM_EMAIL_ALREADY_EXISTS_CODE) return { kind: "already_exists" };
    if (code === UPSTREAM_REGISTRATION_DISABLED_CODE) return { kind: "registration_disabled", upstreamCode: code };
    if (response.status === 200 && code === 0) return { kind: "created" };
    return { kind: "failed", detail: code === undefined ? `http=${response.status}` : `code=${code}` };
  } catch (error) {
    return { kind: "failed", detail: timedOut ? "timeout" : "network", cause: error };
  } finally {
    clearTimeout(timer);
  }
}
