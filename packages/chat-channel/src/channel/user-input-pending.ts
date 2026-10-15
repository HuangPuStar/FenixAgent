// packages/chat-channel/src/channel/user-input-pending.ts
// Peri 待发送队列（steer）在途请求登记：session/input/* 的 JSON-RPC 响应帧只有 id 无 method，
// 命令执行（enqueue/dispatch/takeback）与能力补拉（snapshot）都必须按请求出口登记才能收敛。
//
// 与 session-mutation.ts（会话变更等待器）同模式：登记表挂在 SharedRelay 上，随 relay
// 生命周期释放；响应侧（relay-event-handler）按 rpcId settle，relay 断连时统一失败。
// 三条硬约束（不满足就是"用户点了没反应"）：
// - 超时必须收敛为明确失败：否则命令等待器悬挂、前端 loading 永不消失；
// - 未登记的响应不认领：rpcId 命名空间与 prompt / 会话同步共用，误认领会吞掉它们的收敛；
// - settle 之后登记即删除：迟到的响应不得二次 settle（重复 settle 会让命令重复提交）。

import type {
  SharedRelay,
  UserInputRequestHandle,
  UserInputRequestKind,
  UserInputRequestOutcome,
} from "./connection-types";

/**
 * 默认等待上限（毫秒）。peri 的队列操作都是本地状态变更（入队 / 派发标记 / 撤回），
 * 不应比取消确认更慢；与 session-channel 的取消兜底超时同量级。
 */
export const DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * 登记一次在途 steer 请求。
 * 超时按 AGENT_UNAVAILABLE 收敛（与 relay 断连同归类：都是"回执不可达"，可重试）；
 * cancel() 供发送失败路径立即终止等待，避免登记残留到超时。
 */
export function registerUserInputRequest(
  shared: SharedRelay,
  options: { rpcId: number | string; kind: UserInputRequestKind; timeoutMs?: number },
): UserInputRequestHandle {
  const { rpcId, kind } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS;
  if (!shared.pendingUserInputRequests) shared.pendingUserInputRequests = new Map();

  let finish: (outcome: UserInputRequestOutcome) => void = () => {};
  const completed = new Promise<UserInputRequestOutcome>((resolve) => {
    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout", publicErrorType: "ACTION.AGENT_UNAVAILABLE" });
    }, timeoutMs);
    finish = (outcome) => {
      clearTimeout(timer);
      shared.pendingUserInputRequests?.delete(rpcId);
      resolve(outcome);
    };
  });
  shared.pendingUserInputRequests.set(rpcId, { kind, settle: finish });
  return {
    completed,
    cancel: () => finish({ ok: false, reason: "relay_closed", publicErrorType: "ACTION.AGENT_UNAVAILABLE" }),
  };
}

/**
 * 消费一条在途登记并 settle（响应到达时调用）。
 * 未登记时返回 undefined：调用方不得把该响应当作 steer 回执处理。
 */
export function settleUserInputRequest(
  shared: SharedRelay,
  rpcId: number | string,
  outcome: UserInputRequestOutcome,
): void {
  const registration = shared.pendingUserInputRequests?.get(rpcId);
  if (!registration) return;
  shared.pendingUserInputRequests?.delete(rpcId);
  registration.settle(outcome);
}

/**
 * relay 断连（Agent 实例失效）使全部在途请求失败：Agent 已死，回执不可能到达，
 * 继续等待只会让前端停在"发送中"。与 failPendingSessionMutations 同语义（不重试）。
 */
export function failPendingUserInputRequests(shared: SharedRelay): void {
  for (const registration of Array.from(shared.pendingUserInputRequests?.values() ?? [])) {
    registration.settle({ ok: false, reason: "relay_closed", publicErrorType: "ACTION.AGENT_UNAVAILABLE" });
  }
  shared.pendingUserInputRequests?.clear();
}
