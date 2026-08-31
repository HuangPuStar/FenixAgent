// packages/chat-channel/src/channel/action-forward.ts
// 前端 Action → SessionChannel 的转发与缓冲消息重放（迁移自 ws-lifecycle.ts，语义原样保留）。
//
// 独立成文件使 gateway.ts 保持在行数上限内；两者共享同一依赖注入面，
// 以便协议层测试用 fake SessionChannel 覆盖缓冲/重放时序。

import { createPublicError, serializePublicErrorLog } from "../public-error";
import type { SessionChannel, SessionConnection } from "./session-channel";
import type { ActionAck, ActionError } from "./types";

export type ForwardYjsActionDependencies = {
  sessionChannel: SessionChannel;
  sendAck: (ack: ActionAck) => void;
  sendError: (error: ActionError) => void;
  reportError: (message: string, error: unknown) => void;
  /** 公开错误安全事件 sink；只接受低敏结构化 JSON。 */
  reportLog: (message: string) => void;
};

/** 转发一条 Action 到 SessionChannel；失败时回退为脱敏 AGENT_UNAVAILABLE 错误（保留诊断上下文） */
export async function forwardYjsAction(
  entry: SessionConnection,
  action: Record<string, unknown>,
  dependencies: ForwardYjsActionDependencies,
): Promise<void> {
  try {
    await dependencies.sessionChannel.handleAction(entry, action, {
      sendAck: dependencies.sendAck,
      sendError: dependencies.sendError,
    });
  } catch (err) {
    const error = createPublicError("INTERNAL.UNCLASSIFIED");
    dependencies.reportError(
      "[YJS-FE] failed to process action before relay forward",
      err instanceof Error ? err.name : typeof err,
    );
    dependencies.reportLog(serializePublicErrorLog(error, "action.forward"));
    dependencies.sendError({
      type: "action_error",
      commandId: typeof action.commandId === "string" ? action.commandId : "",
      error,
    });
  }
}

/** 重放 relayReady 前缓冲的客户端消息（list_sessions 跳过：连接建立后由 status 触发） */
export async function flushPendingYjsActions(
  entry: SessionConnection,
  pending: string[],
  dependencies: ForwardYjsActionDependencies,
): Promise<void> {
  for (const message of pending) {
    try {
      const action = JSON.parse(message) as Record<string, unknown>;
      if (!action.action || action.action === "list_sessions") continue;
      await forwardYjsAction(entry, action, dependencies);
    } catch (err) {
      dependencies.reportError("[YJS-FE] flush message failed", typeof err);
    }
  }
}
