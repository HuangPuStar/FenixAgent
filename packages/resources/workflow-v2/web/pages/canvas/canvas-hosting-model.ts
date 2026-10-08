// pages/canvas/canvas-hosting-model.ts
// 画布宿主页的**状态推导**（纯函数：无 React、无网络、无 DOM）。
//
// 页面要回答两个独立的问题，混在一起写是这类宿主页最常见的缺陷来源：
// 1. 「上游准备好了吗」——租户绑定与平台空间是否可用（决定能不能拼出 iframe URL）；
// 2. 「画布握手到哪一步了」——ready / token / 超时 / 会话失效（决定盖在 iframe 上的是骨架还是降级卡）。
//
// 这里把两者各自收敛成一个判别联合，页面只做 `state.kind` 的分派；分支为什么不合并：上游未就绪时
// **根本没有 iframe 可挂**（URL 里必须有真实 `space_id`），与「iframe 挂了但握手失败」是两种界面。

import type { WorkflowV2OrgAppBinding, WorkflowV2PlatformAccount } from "../../api/canvas-session";

/** 上游未就绪的原因；每个原因对应一段不同的引导文案（未绑定与平台空间缺失的处理动作不同）。 */
export type CanvasUpstreamReason = "unbound" | "degraded" | "space-missing" | "probe-failed";

/** 上游就绪状态：`pending`=探测中（骨架），`ready`=可拼 URL，`blocked`=降级并给引导。 */
export type CanvasUpstream =
  | { readonly state: "pending" }
  | { readonly state: "ready"; readonly platformSpaceId: string }
  | { readonly state: "blocked"; readonly reason: CanvasUpstreamReason };

/** 探测结果：两个控制台端点并行取回后交给 `resolveCanvasUpstream`。 */
export type CanvasUpstreamProbe =
  | { readonly status: "pending" }
  | { readonly status: "failed" }
  | {
      readonly status: "loaded";
      readonly binding: WorkflowV2OrgAppBinding;
      readonly account: WorkflowV2PlatformAccount;
    };

/**
 * 探测结果 → 上游就绪状态。
 *
 * 判定顺序（先失败后就绪，避免「探测失败」被当成「没绑定」）：
 * 1. 请求失败 → `probe-failed`：状态未知，给重试而不是断言未绑定；
 * 2. 未绑定（`status: unbound`，或服务端回 `appId: null`）→ `unbound`：按设计 §6.2 的 empty 引导；
 * 3. 绑定已被上游标记 `degraded` → `degraded`；
 * 4. 平台空间 ID 为空 → `space-missing`：此时拼不出带真实 `space_id` 的 URL，**不得**用空值兜底。
 *
 * 平台账号的 `status` 不参与判定：会话失效由 BFF 的单飞重登兜底（`upstream-client`），在这里拦会把
 * 「BFF 一次重登即可自愈」的场景误判成不可用。
 */
export function resolveCanvasUpstream(probe: CanvasUpstreamProbe): CanvasUpstream {
  if (probe.status === "pending") return { state: "pending" };
  if (probe.status === "failed") return { state: "blocked", reason: "probe-failed" };
  if (probe.binding.status === "unbound" || probe.binding.appId === null)
    return { state: "blocked", reason: "unbound" };
  if (probe.binding.status === "degraded") return { state: "blocked", reason: "degraded" };
  const platformSpaceId = probe.account.spaceId?.trim() ?? "";
  if (platformSpaceId.length === 0) return { state: "blocked", reason: "space-missing" };
  return { state: "ready", platformSpaceId };
}

/**
 * 握手阶段。`connecting` 是挂载后的初始态，也是重试后的复位目标。
 *
 * - `interactive`：票据已下发，iframe 可交互（骨架撤除）；
 * - `timeout`：`ready` 未在窗口内到达（设计 §5.4 的「初始化超时」）；
 * - `load-failed`：iframe 自身加载失败（连接级错误时画布不会发出 `ready`）；
 * - `handshake-failed`：取 code 或兑换票据失败（画布侧等不到 token，必须由宿主收口）；
 * - `canvas-error`：画布上报 `error`；
 * - `session-expired`：续期失败 → 已向画布下发 `signout`，覆盖层承接。
 */
export type CanvasFramePhase =
  | "connecting"
  | "interactive"
  | "timeout"
  | "load-failed"
  | "handshake-failed"
  | "canvas-error"
  | "session-expired";

/** 页面的三种视图：整页骨架 / 未就绪降级 / iframe（握手阶段决定盖什么）。 */
export type CanvasViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "blocked"; readonly reason: CanvasUpstreamReason }
  | { readonly kind: "frame"; readonly phase: CanvasFramePhase; readonly retryable: boolean };

/** 组合上游状态与握手阶段；`retryable` 只对 `canvas-error` 有意义（其余失败固定可重试）。 */
export function resolveCanvasViewState(input: {
  readonly upstream: CanvasUpstream;
  readonly phase: CanvasFramePhase;
  readonly retryable: boolean;
}): CanvasViewState {
  if (input.upstream.state === "pending") return { kind: "loading" };
  if (input.upstream.state === "blocked") return { kind: "blocked", reason: input.upstream.reason };
  return { kind: "frame", phase: input.phase, retryable: input.retryable };
}

/**
 * 状态变化的读屏播报键（`aria-live` 区域的内容）。
 *
 * 只播报**能听见的语义变化**，不逐帧播报骨架：`connecting` 与 `interactive` 用同一句「画布加载中/就绪」，
 * 细分阶段（超时、加载失败…）统一归到 `failed`，具体原因由降级卡的可聚焦文本承担。
 */
export function canvasAnnouncementKey(state: CanvasViewState): string {
  if (state.kind === "loading") return "canvas.announce.loading";
  if (state.kind === "blocked") return "canvas.announce.blocked";
  if (state.phase === "connecting") return "canvas.announce.connecting";
  if (state.phase === "interactive") return "canvas.announce.ready";
  if (state.phase === "session-expired") return "canvas.announce.sessionExpired";
  return "canvas.announce.failed";
}
