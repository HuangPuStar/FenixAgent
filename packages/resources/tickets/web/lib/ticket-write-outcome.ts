/**
 * 写路径的纯逻辑：202 受理体判别 + 「一次用户动作一个幂等键」的持有者 + 写请求内容指纹。
 *
 * 纯逻辑 = 不 import React、不读 i18n 单例、不发请求、不依赖 UI 图标包，因此可以在没有 DOM 的用例里
 * 直接跑（幂等键复用与 202 判别都是先有单元测试、后有界面的行为）。
 *
 * 幂等键在这里而不是在域模块里生成：一次用户动作对应一个键，重试（网络超时后用户再点一次）必须复用；
 * 若在域模块内生成，每次调用都是新键，服务端的去重账本就永远命中不了同一个操作。
 */

import type { TicketWriteAccepted } from "../api/tickets";

/**
 * 一次写动作的终局。定义在纯逻辑层而不是某个 hook 里：工单字段、标签、评论三条写路径共用同一套判别语义
 * （矩阵逐格见前端合同 §8.1），放在 hook 里会让另外两条路径为了拿这个类型而反向依赖某一个 hook。
 *
 * - `applied` 已生效（页面数据已就地替换）；
 * - `accepted` 202：上游结果未定，界面进入待确认态，**不算成功**；
 * - `conflict` 409 版本冲突：内容在读取与提交之间被改过，必须基于最新内容重新提交；
 * - `pending` 409 在途互斥：该工单已有一笔未确认的写（刷新一次由快照的 `pendingOperationId` 接管）；
 * - `denied` 403：权限是持久状态，不给重试；
 * - `failed` 其它失败（网络 / 5xx / 503）：草稿保留，重试复用旧键；
 * - `blocked` 本地已判定不该发请求（有待确认的写、或标签没有变更），**没有发出请求**。
 */
export type TicketWriteOutcome = "applied" | "accepted" | "conflict" | "pending" | "denied" | "failed" | "blocked";

/**
 * 判断写响应是否 202 受理体（`{ operationId, status: "uncertain" }`）。
 *
 * 入参是泛型联合（`T | TicketWriteAccepted`）而不是某个具体写结果类型：评论、标签与工单修改各有自己的
 * 200 形状，但 202 的形状与语义完全一致，判别只该有一处。放宽类型不影响运行期行为——仍然只看
 * `status` 的值：200/201 的资源体只有 `state` / `commentId` 之类字段，不存在同名歧义，因此不需要 zod。
 */
export function isUncertainAccepted<T extends object>(result: T | TicketWriteAccepted): result is TicketWriteAccepted {
  return "status" in result && (result as { status?: unknown }).status === "uncertain";
}

/**
 * 写请求的内容指纹：字段按**固定顺序**拼 `\u0000`（`null` / `undefined` 归一成空串）。
 *
 * `expectedVersion` 必须参与：版本变化说明用户是在「另一份内容」上重试，此时必须换代，否则重试会命中
 * 服务端已持久化的那次失败（失败重放语义），永远发不出去。签名也必须覆盖请求体的**全部**字段——
 * 多一个、少一个都会让「同键不同内容」的服务端校验与前端意图不一致。
 */
export function writeSignature(parts: readonly (string | null | undefined)[]): string {
  return parts.map((part) => part ?? "").join("\u0000");
}

/** 一次用户动作的幂等键持有者：内容不变则复用，内容变化或动作终结后换代。 */
export interface IdempotencyKeyHolder {
  /** 取本次提交的键；`signature` 是本次动作的内容指纹。 */
  take(signature: string): string;
  /**
   * 换代。**必须调用**：动作成功之后（同一界面要能连发第二个动作）、动作以明确失败或幂等冲突终结之后。
   * **不得调用**：传输失败（`NETWORK_ERROR`）、5xx/503 之后（用户重试必须复用旧键），以及 202 待确认期间
   *（这段时间不重发，也不该换代）。
   */
  reset(): void;
}

/**
 * 同内容重试（网络超时、用户再点一次）复用同一键，服务端据此返回原操作而不是重复写入；
 * 内容变化必须换代——同键不同内容会被服务端按 `IDEMPOTENCY_CONFLICT` 拒绝。
 */
export function createIdempotencyKeyHolder(generate: () => string = newIdempotencyKey): IdempotencyKeyHolder {
  let signature: string | null = null;
  let key: string | null = null;
  return {
    take(nextSignature: string): string {
      if (key === null || signature !== nextSignature) {
        key = generate();
        signature = nextSignature;
      }
      return key;
    },
    reset(): void {
      key = null;
      signature = null;
    },
  };
}

/** 表单内容指纹：只含参与幂等语义的字段（标题与正文），其余状态变化不该换代。 */
export function ticketFormSignature(values: { title: string; body?: string }): string {
  return `${values.title}\u0000${values.body ?? ""}`;
}

/**
 * UUID v4。不直接调 `crypto.randomUUID()`：它只在 secure context（HTTPS / localhost）可用，纯 HTTP 部署
 * 时是 `undefined`；宿主入口虽然装了全局 polyfill，但包内代码与包内用例不能依赖宿主入口。降级按
 * RFC 4122 v4 手写（`crypto.getRandomValues` 不受 secure context 限制）。
 *
 * 与 `@fenix/resource-machine` 的 `web/lib/random-uuid.ts` 逻辑同源：第二次出现其它消费者时再下沉到
 * `@fenix/ui-components/lib/`，本批不为此新增跨包契约。
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
