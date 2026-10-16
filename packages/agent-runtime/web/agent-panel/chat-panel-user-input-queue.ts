// chat-panel-user-input-queue.ts
// 待发送队列（peri steer）的出站端口装配：三个控制面 action 的字面量、`inputId` 生成与能力键集中在此，
// 与 `use-chat-panel-runtime.ts` 的连接状态机解耦（该文件的行数已逼近 500 行红线）。
//
// 出站口径（与数据契约一致，不在前端改名）：
// - `enqueue_user_input` / `dispatch_user_inputs` / `takeback_user_input` 均**不携带 sessionId**：
//   该控制面按连接的会话绑定路由，与 `send_prompt` 的显式绑定口径不同；
// - `inputId` 是前端生成的 UUID（队列项标识，服务端按它去重 / 派发），与 `commandId` 同用本包的
//   `randomUUID`（非 secure context 下降级到 getRandomValues，见 `../lib/random-uuid`）；
// - 三个 action 共用 `sendAction` 出口：返回 false 表示没写进 socket（渲染层据此给可重试提示）。

import type { UserInputQueueEnqueueRequest } from "@fenix/ui-components/chat/shell/chat-interface-types";
import { randomUUID } from "../lib/random-uuid";

/** 出站发送出口（`use-chat-panel-runtime` 的 `sendAction`）：返回是否真正写入 socket。 */
export type UserInputQueueSendAction = (data: Record<string, unknown>) => boolean;

/** `ChatPanelCallbacks` 里待发送队列相关的那三项出站回调。 */
export interface UserInputQueueSendPorts {
  /** 入队：返回是否真正写入 socket（false 由渲染层给出可重试提示） */
  onEnqueueUserInput: (request: UserInputQueueEnqueueRequest) => boolean;
  /** 单发（一项）/ 全发（全部 queued 项） */
  onDispatchUserInputs: (inputIds: string[]) => boolean;
  /** 取回待发送项 */
  onTakebackUserInput: (inputId: string) => boolean;
}

/** 用统一的出站出口装配三个队列回调（纯函数，身份随 `sendAction` 变化）。 */
export function createUserInputQueueSendPorts(sendAction: UserInputQueueSendAction): UserInputQueueSendPorts {
  return {
    onEnqueueUserInput: (request) =>
      sendAction({
        action: "enqueue_user_input",
        inputId: randomUUID(),
        content: request.content,
        originalDraft: request.originalDraft,
      }),
    onDispatchUserInputs: (inputIds) => sendAction({ action: "dispatch_user_inputs", inputIds }),
    onTakebackUserInput: (inputId) => sendAction({ action: "takeback_user_input", inputId }),
  };
}
