/**
 * 创建写路径的纯逻辑：202 受理体判别 + 「一次用户动作一个幂等键」的持有者。
 *
 * 纯逻辑 = 不 import React、不读 i18n 单例、不发请求、不依赖 UI 图标包，因此可以在没有 DOM 的用例里
 * 直接跑（幂等键复用与 202 判别都是先有单元测试、后有界面的行为）。
 *
 * 幂等键在这里而不是在域模块里生成：一次用户动作对应一个键，重试（网络超时后用户再点一次）必须复用；
 * 若在域模块内生成，每次调用都是新键，服务端的去重账本就永远命中不了同一个操作。
 */

import type { TicketCreateResult, TicketWriteAccepted } from "../api/tickets";

/**
 * 判断创建响应是否 202 受理体（`{ operationId, status: "uncertain" }`）。
 *
 * 两种形状靠 `status` 判别：201 的工单本体只有 `state`（open/closed），不存在同名歧义，因此不需要 zod。
 */
export function isUncertainAccepted(result: TicketCreateResult): result is TicketWriteAccepted {
  return "status" in result && result.status === "uncertain";
}

/** 一次用户动作的幂等键持有者：表单内容不变则复用，内容变化即换代。 */
export interface IdempotencyKeyHolder {
  /** 取本次提交的键；`signature` 是表单内容指纹。 */
  take(signature: string): string;
}

/**
 * 同内容重试（网络超时、用户再点一次「创建」）复用同一键，服务端据此返回原操作而不是重复建单；
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
