// shell/session-guard.ts
// 根守卫的会话跳转决策表（从 `__root.tsx` 的 effect 抽出为纯函数，便于单测钉住每条分支）。
//
// 为什么"疑似未登录"要复核而不是立即跳登录页：better-auth 客户端在任意一次 `/get-session`
// 判定无会话时都会把会话置空（含 401 与浏览器存量 cookie 造成的瞬时判定），而守卫两侧——无会话
// →登录页、有会话且在登录页→控制台——若都立即反应，会话判定在"有/无"之间抖动时就会形成
// `/ctrl/login ↔ /ctrl/agent` 的跳转循环（存量 cookie 事故的可见形态）。因此这一侧先安排一次
// 延迟复核，复核仍为空才跳；有会话的一侧保持即时，不参与复核。
//
// 复核状态由调用方持有（`verifiedNull`）：`verify` 是"安排复核"，`to-login` 才是"复核后仍为空"。

/** 「疑似未登录」的复核延迟：给瞬时抖动一个自愈窗口，再决定是否踢出。 */
export const SESSION_NULL_VERIFY_DELAY_MS = 1_000;

/** 决策输入；字段来源见各自说明。 */
export interface SessionGuardInput {
  /** `useSession().data` 是否非空。 */
  readonly hasSession: boolean;
  /** 会话仍在解析（含主动复核进行中）；期间渲染加载态，不做跳转、不推进复核状态。 */
  readonly isPending: boolean;
  /** 当前路由路径（TanStack Router 已剥离 `/ctrl` basepath）。 */
  readonly pathname: string;
  /** 管理面板（`/admin*`）：独立于 better-auth 会话体系，不做跳转。 */
  readonly isAdminPath: boolean;
  /** 本轮「疑似未登录」是否已复核（复核后仍为空）。 */
  readonly verifiedNull: boolean;
}

/**
 * 守卫动作：
 * - `idle`：不动；
 * - `verify`：安排延迟复核（调用方负责置位复核状态并在复核结束后触发下一轮决策）；
 * - `to-login` / `to-agent`：跳转（调用方用 `replace` 执行，避免抖动把浏览器历史灌满）。
 */
export type SessionGuardAction = "idle" | "verify" | "to-login" | "to-agent";

/** 决策表；除「未登录先复核」外与既有守卫行为逐条一致。 */
export function decideSessionGuard(input: SessionGuardInput): SessionGuardAction {
  if (input.isPending) return "idle";
  if (input.hasSession) return input.pathname === "/login" ? "to-agent" : "idle";
  if (input.pathname === "/login" || input.isAdminPath) return "idle";
  return input.verifiedNull ? "to-login" : "verify";
}
