/**
 * 平台账号 locale 的**幂等校正**：把上游账号的语言偏好确保为 `zh-CN`。
 *
 * 为什么必须有它：内嵌画布显示什么语言，由**上游账号**的 `locale` 决定，而不是由我这边的请求决定——
 * 服务端的节点名 / 分类名走 `i18n.GetLocale(ctx)`，其值在 `I18nMW` 里取自 `session.Locale`（即
 * `user.locale`）；前端 UI 文案则由 `GlobalLayout` 读 `POST /api/passport/account/info/v2/` 回显的
 * `locale` 再 `I18n.setLang()`。账号一旦以 `en-US` 建出（历史版本的自助注册不带 `Accept-Language`，上游
 * 注册取 `GetLocale(ctx)` 的默认值 `en-US`），画布就整幅是英文，且 URL 的 `lng` 参数与 `x-locale` 头都
 * 不参与这条链路（实测：上游显式传入 lng 会让 detector 失效、后端也不读 `x-locale`）——唯一有效路径是
 * 改账号本身。
 *
 * 接入点（见 `upstream-session` 的 `ensureCookie()`）：会话获取是每一次上游调用的必经之路，也是「我方已
 * 持有平台账号凭据」的那一刻；校正因此对**存量部署**同样生效——`platform-account-bootstrap` 只在台账缺行
 * 时运行，而需要校正的恰是台账已有行、账号却还是英文的那批。
 *
 * 幂等与代价：先读 `account/info/v2` 的 `locale`，已是 `zh-CN` 就**不发写请求**；成功结果按进程记忆
 * （单飞），因此每个进程最多两次出站。失败**不抛错、不阻塞会话获取**，只记不含凭据的告警，并在冷却窗口
 * 内不再重试——上游不可用时不该让每个上游请求都多带两次注定失败的往返。
 *
 * 凭据边界：会话 Cookie 头由调用方传入，只进出站请求头；日志只含结果标签、上游业务码与传输类别。
 */

import { createLogger } from "@fenix/logger";
import { getWorkflowV2Config } from "../config";

const logger = createLogger("wf2-platform-account-locale");

/** 账号信息端点；`data.locale` 是 locale 的唯一事实来源（前端 `GlobalLayout` 读的就是它）。 */
const ACCOUNT_INFO_PATH = "/api/passport/account/info/v2/";

/** 资料更新端点（上游 `_user.POST("/update_profile")`，请求体里 `locale` 是可选字段）。 */
const UPDATE_PROFILE_PATH = "/api/user/update_profile";

/** 目标语言：上游 `i18n.LocaleZH`，也是 `GetLocale` 唯一认作中文的取值（其余一律回退 `en-US`）。 */
export const PLATFORM_ACCOUNT_LOCALE_ZH = "zh-CN";

/**
 * 校正结果四态。
 *
 * - `already_zh`：本来就是 `zh-CN`，未发出站写请求（幂等判据）；
 * - `updated`：检测到非 `zh-CN` 并改写成功；
 * - `failed`：读取或写入未完成（业务码 / HTTP / 传输），调用方无需处理——已按降级处理；
 * - `cooldown`：上一次失败后的冷却窗口内，本次未出站。
 *
 * 后两态都**不是**调用方的失败：会话获取照常返回，画布最多继续显示英文。
 */
export type PlatformAccountLocaleOutcome =
  | { readonly kind: "already_zh" }
  | { readonly kind: "updated" }
  /** `detail` 沿用会话与注册模块的写法（`code=...` / `http=...` / `timeout` / `network` / `malformed`）。 */
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "cooldown" };

/**
 * 失败后的重试冷却。
 *
 * 取 60 秒：失败时 `ensureCookie()` 会被每一个上游请求调用，没有冷却就意味着上游故障期间请求量翻三倍；
 * 而这个窗口只影响「校正要等多久生效」，不影响任何请求的成败，取分钟级足够。
 */
const RETRY_COOLDOWN_MS = 60_000;

/** 进程级记忆：成功的校正（单飞句柄）；失败后清空并进入冷却，让 `ensureCookie` 的下一次调用不必重复等。 */
let ensured: Promise<PlatformAccountLocaleOutcome> | null = null;

/** 最近一次失败的时刻；冷却窗口内不再出站。 */
let failedAtMs: number | null = null;

/** 测试用：清掉进程级记忆（成功结果与失败冷却），让下一个用例从零开始。 */
export function resetPlatformAccountLocaleForTests(): void {
  ensured = null;
  failedAtMs = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON 解析失败返回 null：本模块只关心业务码与 `data.locale`，响应不是 JSON 时按「未完成」处理。 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readBusinessCode(payload: unknown): number | undefined {
  if (!isRecord(payload)) return;
  return typeof payload.code === "number" ? payload.code : undefined;
}

/** `data.locale`；上游在账号没有 locale 时整个字段缺席，因此这里把「非字符串」按 null 返回（不是失败）。 */
function readLocale(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.data)) return null;
  const locale = payload.data.locale;
  return typeof locale === "string" ? locale : null;
}

/** 一次出站的结果：要么拿到上游信封，要么是一个不含凭据的传输类别。 */
type PostOutcome =
  | { readonly kind: "ok"; readonly status: number; readonly payload: unknown }
  | Extract<PlatformAccountLocaleOutcome, { kind: "failed" }>;

/**
 * 带上会话发一次 JSON POST。
 *
 * 与 `platform-account-registration` 同一口径（同一个上游面、同一种诊断写法）：超时经 `AbortController`
 * 收口，业务码优先于 HTTP 状态；**不抛错**——本模块的失败一律是降级，不是调用方的错误。
 */
async function postWithSession(
  path: string,
  cookieHeader: string,
  body: Record<string, unknown>,
): Promise<PostOutcome> {
  const config = getWorkflowV2Config();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.upstreamTimeoutMs);

  try {
    const response = await fetch(`${config.upstreamBaseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return { kind: "ok", status: response.status, payload: safeJson(text) };
  } catch {
    // 传输类失败的底层消息不进诊断：本模块只保留类别标签，且它不影响调用方的任何分支。
    return { kind: "failed", detail: timedOut ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** 把一次出站归约为「业务码为 0」或一个失败标签；上游的业务错误一律是 HTTP 200 + 非零 code。 */
function toFailure(outcome: PostOutcome): { kind: "failed"; detail: string } | null {
  if (outcome.kind === "failed") return outcome;
  const code = readBusinessCode(outcome.payload);
  if (outcome.status === 200 && code === 0) return null;
  if (code === undefined) return { kind: "failed", detail: `http=${outcome.status}` };
  return { kind: "failed", detail: `code=${code}` };
}

/** 读当前 locale → 非 zh-CN 才写回；任何一步未完成都归成 `failed`（不抛错）。 */
async function runEnsure(cookieHeader: string): Promise<PlatformAccountLocaleOutcome> {
  const read = await postWithSession(ACCOUNT_INFO_PATH, cookieHeader, {});
  const readFailure = toFailure(read);
  if (readFailure !== null) {
    logger.warn("workflow-v2 平台账号 locale 读取失败，本次跳过校正", { detail: readFailure.detail });
    return readFailure;
  }

  const current = read.kind === "ok" ? readLocale(read.payload) : null;
  if (current === PLATFORM_ACCOUNT_LOCALE_ZH) return { kind: "already_zh" };

  // 缺失（字段缺席）与其它取值同样处理：都按「不是 zh-CN」改写一次，因此空 locale 的账号也会被带上中文。
  const write = await postWithSession(UPDATE_PROFILE_PATH, cookieHeader, { locale: PLATFORM_ACCOUNT_LOCALE_ZH });
  const writeFailure = toFailure(write);
  if (writeFailure !== null) {
    logger.warn("workflow-v2 平台账号 locale 校正失败，画布可能仍为英文", {
      from: current ?? "none",
      detail: writeFailure.detail,
    });
    return writeFailure;
  }

  logger.info("workflow-v2 平台账号 locale 已校正为中文", { from: current ?? "none" });
  return { kind: "updated" };
}

/**
 * 确保平台账号的 locale 为 `zh-CN`（幂等、单飞、永不抛错）。
 *
 * 调用方（`upstream-session.ensureCookie()`）只把它当作会话获取的一部分：失败与冷却都照常返回，会话不受
 * 影响。这里的进程级记忆保证每个进程最多出站两次——`ensureCookie` 是每次上游请求都会走的路径，没有记忆
 * 就等于给每个请求加两次往返。
 */
export async function ensurePlatformAccountLocale(cookieHeader: string): Promise<PlatformAccountLocaleOutcome> {
  if (ensured !== null) return ensured;
  if (failedAtMs !== null && Date.now() - failedAtMs < RETRY_COOLDOWN_MS) return { kind: "cooldown" };

  // 单飞句柄同步登记：并发 `ensureCookie()` 共享同一次校正，不会各发一轮出站。
  const attempt = runEnsure(cookieHeader).catch((error: unknown) => {
    // 兜住 runEnsure 自身的意外异常（它内部已按降级处理已知失败）：校正的任何问题都不该让会话获取失败。
    logger.warn("workflow-v2 平台账号 locale 校正异常", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: "failed", detail: "unexpected" } as const;
  });
  ensured = attempt;

  const outcome = await attempt;
  if (outcome.kind === "failed" && ensured === attempt) {
    // 只清自己这一轮：失败不记忆成「本进程不再校正」，但也不让它立刻被下一个上游请求重复触发。
    ensured = null;
    failedAtMs = Date.now();
  }
  return outcome;
}
