import { error as logError } from "@fenix/logger";
import type { ImSessionHandle, ImSessionInstanceRef, ImSessionPort, ImSessionTarget } from "../../ports/im-session";

/**
 * IM 会话冷启动桥接（规格 §6.1 第 5-6 步 / §6.3）。
 *
 * 平台只向 IM 会话发这一次 prompt：peri 在首个 turn 才注册 inbox 订阅与激活监听，早于首次 prompt
 * 发送的通知没有订阅者，会直接丢失。暖态因此按 conversation 记在进程内，实例代次或会话键变化即作废。
 *
 * 冷启动失败只能上抛 `COLD_START_FAILED`，不得降级为暖态：降级等于让调用方改走订阅通知，而 inbox
 * 尚未注册，积压消息会永久停在 `received`。
 */

/** 通用唤醒：不含正文、发送者与聊天标识，一次唤醒处理 inbox 中的全部积压。 */
export const IM_WAKE_PROMPT_TEXT =
  "IM 消息已到达。请调用 resources/read 读取 im://inbox 并处理其中全部待处理消息；没有待处理消息时不要回复。";

/**
 * 手动停止不再意味着拒绝启动：端口会先触发一次显式唤醒，只有唤醒本身失败才是 `WAKE_FAILED`；
 * `INSTANCE_STOPPED` 保留为兜底，用于尚未实现唤醒的端口。
 */
export type ImSessionFailureCode =
  | "ENSURE_INSTANCE_FAILED"
  | "INSTANCE_STOPPED"
  | "WAKE_FAILED"
  | "OPEN_SESSION_FAILED"
  | "COLD_START_FAILED";

/** 端口与资源包只共享稳定字符串码，不共享错误类型。 */
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** 冷启动链路的失败面；`code` 用于把事件标记为 `failed` 并写入稳定原因。 */
export class ImSessionBridgeError extends Error {
  readonly code: ImSessionFailureCode;
  readonly conversationId: string;

  constructor(code: ImSessionFailureCode, conversationId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImSessionBridgeError";
    this.code = code;
    this.conversationId = conversationId;
  }
}

export type ImSessionOpenOutcome =
  | { readonly kind: "cold_started"; readonly acpSessionId: string }
  | { readonly kind: "warm" };

export interface ImSessionBridge {
  /**
   * 确保专属实例；冷启动时打开会话并发送一次通用唤醒，暖态直接返回。
   *
   * 每次调用都检查实例代次：实例被回收后重启时 uid 不变，只有 runtimeToken 变化，必须重新冷启动。
   */
  open(input: ImSessionTarget): Promise<ImSessionOpenOutcome>;
  /**
   * 暖态但订阅流已断开时补一次唤醒 prompt。
   *
   * 暖态通知依赖 Agent 在首个 turn 注册的 MCP 订阅；turn 结束该流即关闭，此时通知无人接收，
   * 只有 prompt 能让 Agent 重新读取 inbox。调用方必须先确认订阅已不存在。
   */
  wake(input: ImSessionTarget): Promise<ImSessionOpenOutcome>;
  /** 会话被重建（例如 `session/load` 失败后新建）时作废暖态，由执行重建的调用方显式调用。 */
  invalidate(conversationId: string): void;
  /** 诊断与测试用：该聊天当前是否处于暖态。 */
  isWarm(conversationId: string): boolean;
}

export interface ImSessionBridgeDeps {
  readonly port: ImSessionPort;
}

interface WarmRecord {
  readonly instanceId: string;
  readonly runtimeToken: string;
  readonly rcsSessionId: string;
}

interface InFlightColdStart {
  readonly rcsSessionId: string;
  readonly promise: Promise<ImSessionOpenOutcome>;
}

export function createImSessionBridge(deps: ImSessionBridgeDeps): ImSessionBridge {
  const warm = new Map<string, WarmRecord>();
  /** 同一聊天的并发消息共享一次冷启动；否则每条消息都会发一次唤醒 prompt。 */
  const inFlight = new Map<string, InFlightColdStart>();

  async function ensureInstance(input: ImSessionTarget): Promise<ImSessionInstanceRef> {
    try {
      return await deps.port.ensureInstance({
        conversationId: input.conversationId,
        organizationId: input.organizationId,
        ownerUserId: input.ownerUserId,
        agentConfigId: input.agentConfigId,
      });
    } catch (error) {
      if (hasErrorCode(error, "IM_WAKE_FAILED")) {
        throw new ImSessionBridgeError("WAKE_FAILED", input.conversationId, "IM 实例自动唤醒失败", { cause: error });
      }
      if (hasErrorCode(error, "INSTANCE_STOPPED")) {
        throw new ImSessionBridgeError("INSTANCE_STOPPED", input.conversationId, "IM 专属实例已停止", { cause: error });
      }
      throw new ImSessionBridgeError("ENSURE_INSTANCE_FAILED", input.conversationId, "IM 专属实例启动失败", {
        cause: error,
      });
    }
  }

  function isWarmFor(record: WarmRecord | undefined, instance: ImSessionInstanceRef, input: ImSessionTarget): boolean {
    if (!record) return false;
    return (
      record.instanceId === instance.instanceId &&
      record.runtimeToken === instance.runtimeToken &&
      // 路由改绑 Agent 会重建 rcsSessionId；旧会话属于旧 Agent，不能继续视为暖态。
      record.rcsSessionId === input.rcsSessionId
    );
  }

  /** 释放失败只记日志：prompt 已被接受，泄漏一个消费租约不应把成功的投递改判为失败。 */
  async function closeQuietly(session: ImSessionHandle): Promise<void> {
    try {
      await deps.port.close(session);
    } catch (error) {
      logError(`[im-session] 释放会话失败：conversationId=${session.conversationId}`, error);
    }
  }

  async function coldStart(input: ImSessionTarget, instance: ImSessionInstanceRef): Promise<ImSessionOpenOutcome> {
    let session: ImSessionHandle;
    try {
      session = await deps.port.openSession({ target: input, instance });
    } catch (error) {
      throw new ImSessionBridgeError("OPEN_SESSION_FAILED", input.conversationId, "IM 会话打开失败", { cause: error });
    }

    try {
      await deps.port.sendWakePrompt({ session, text: IM_WAKE_PROMPT_TEXT });
    } catch (error) {
      throw new ImSessionBridgeError("COLD_START_FAILED", input.conversationId, "IM 冷启动唤醒失败", { cause: error });
    } finally {
      await closeQuietly(session);
    }

    warm.set(input.conversationId, {
      instanceId: instance.instanceId,
      runtimeToken: instance.runtimeToken,
      rcsSessionId: input.rcsSessionId,
    });
    return { kind: "cold_started", acpSessionId: session.acpSessionId };
  }

  /**
   * 发起冷启动并共享同会话键的在途调用。
   *
   * 实例确保留在调用方：暖态判断必须复用同一次 `ensureInstance`，否则每次 open 都会多调一次端口。
   */
  async function startColdStart(input: ImSessionTarget, instance: ImSessionInstanceRef): Promise<ImSessionOpenOutcome> {
    // 两次 await 之间可能已有同会话完成了冷启动。
    const started = inFlight.get(input.conversationId);
    if (started?.rcsSessionId === input.rcsSessionId) return await started.promise;

    const entry: InFlightColdStart = { rcsSessionId: input.rcsSessionId, promise: coldStart(input, instance) };
    inFlight.set(input.conversationId, entry);
    try {
      return await entry.promise;
    } finally {
      // 只清理自己的条目：并发换 Agent 时同一 conversation 可能已被新的在途冷启动覆盖。
      if (inFlight.get(input.conversationId) === entry) inFlight.delete(input.conversationId);
    }
  }

  return {
    async open(input) {
      // 同一会话键的在途冷启动才可共享：换 Agent 后 rcsSessionId 不同，旧唤醒不属于新会话。
      const running = inFlight.get(input.conversationId);
      if (running?.rcsSessionId === input.rcsSessionId) {
        await running.promise;
        return { kind: "warm" };
      }

      const instance = await ensureInstance(input);
      if (isWarmFor(warm.get(input.conversationId), instance, input)) return { kind: "warm" };

      // 两次 await 之间可能已有同会话完成了冷启动；对 open 而言这就是暖态。
      const started = inFlight.get(input.conversationId);
      if (started?.rcsSessionId === input.rcsSessionId) {
        await started.promise;
        return { kind: "warm" };
      }

      return await startColdStart(input, instance);
    },

    async wake(input) {
      // 跳过暖态判断：暖态记录只能说明会话存在，不能证明订阅仍活着。
      const running = inFlight.get(input.conversationId);
      if (running?.rcsSessionId === input.rcsSessionId) return await running.promise;

      const instance = await ensureInstance(input);
      return await startColdStart(input, instance);
    },

    invalidate(conversationId) {
      warm.delete(conversationId);
    },

    isWarm(conversationId) {
      return warm.has(conversationId);
    },
  };
}
