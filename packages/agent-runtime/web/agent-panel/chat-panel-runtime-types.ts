import type { ActionError, PublicErrorInfo, TerminalWsUiCode, YjsHistoryIncomplete } from "@fenix/chat-channel";
import type {
  UserInputQueueEnqueueRequest,
  UserInputQueueView,
} from "@fenix/ui-components/chat/shell/chat-interface-types";
import type { ChatAuthState } from "../hooks/chat-auth-state";
import type { ChatWsConnectionState } from "../hooks/chat-visible-reconnect";
import type { useChatState } from "../hooks/use-chat-state";
import type { useSessionState } from "../hooks/use-session-state";
import type { useSyncChatState } from "../hooks/use-sync-chat-state";
import type { PeriTaskViewsResult } from "./chat-panel-host-ports";

/** 回执丢失时保存原始输入，不能将旧会话输入自动改投到新会话。 */
export interface PreservedPrompt {
  commandId: string;
  sessionId: string | null;
  content: unknown[];
  outcomeUnknown: boolean;
}
/** `ACPMain` 的出站回调集合（`sessionState.acpSessionId` 变化时重建，见下）。 */ export interface ChatPanelCallbacks {
  onSendPrompt: (contentBlocks: unknown[]) => void;
  onCancel: () => void;
  /**
   * 创建会话并等待服务端创建回执。
   *
   * 返回 Agent 实际创建出的 ACP session id；`null` 表示本次没有确认的创建结果
   * （发送失败 / Agent 拒绝 / 超时 / 断连）。调用方据此把「本次点击的归属」绑定到
   * 本页本次创建，而不是把共享 active session 的任何变化当成创建结果。
   */
  onCreateSession: () => Promise<string | null>;
  /** 返回命令是否真正写入 socket；false 时不得标记已进入会话。 */
  onLoadSession: (sid: string) => boolean;
  /** 返回命令是否真正写入 socket；false 时不得标记已进入会话。 */
  onResumeSession: (sid: string) => boolean;
  onRenameSession: (sid: string, title: string) => void;
  onDeleteSession: (sid: string) => void;
  onRespondPermission: (requestId: string, optionId: string | null) => void;
  onRespondQuestion: (questionId: string, answers: Array<string | string[]>) => void;
  onSetMode: (modeId: string) => void;
  // ── 待发送队列（peri steer）：`inputId`/`commandId` 都在本层生成（同 `send_prompt` 的出站口径）──
  /** 入队：返回是否真正写入 socket（false 由渲染层给出可重试提示） */
  onEnqueueUserInput: (request: UserInputQueueEnqueueRequest) => boolean;
  /** 单发（一项）/ 全发（全部 queued 项） */
  onDispatchUserInputs: (inputIds: string[]) => boolean;
  /** 取回待发送项 */
  onTakebackUserInput: (inputId: string) => boolean;
}
/** `ACPMain` 需要的派生展示态（从 Chat Doc 的能力/模型/模式子树投影）。 */
export interface ChatPanelDerivedState {
  supportsImages: boolean;
  modelName: string | undefined;
  supportsLoadSession: boolean;
  availableCommands: ReturnType<typeof useChatState>["state"]["availableCommands"];
  availableModes: { id: string; name: string }[];
  currentModeId: string | null;
  supportsModeSelection: boolean;
  /** 能力位 `capabilities['peri.userInputQueue']`（Session Doc agent.capabilities 派生） */
  supportsUserInputQueue: boolean;
  tokenUsage: ReturnType<typeof useChatState>["state"]["tokenUsage"];
}
/**
 * ChatPanel 的运行时状态与出站出口。
 *
 * `chatState` / `sessionState` 是两份 Y.Doc 的读数（DocHub 共享实例），`periTasks` 单独订阅
 * Session Doc 的 tasks 子树；三者由本 hook 统一持有，渲染层只做分支。
 */
export interface ChatPanelRuntime {
  authState: ChatAuthState;
  connectionState: ChatWsConnectionState;
  /** 最近一次服务端分类错误；责任域由错误产生边界提供，不能按 WebSocket 通道猜测。 */
  classifiedError: PublicErrorInfo | null;
  /** 最近一次 action_error（transient banner）；不进入 connectionState 状态机。 */
  actionError: ActionError | null;
  /** 被拒输入在用户明确处理前保留完整内容，包括图片与附件。 */
  preservedPrompt: PreservedPrompt | null;
  retryPreservedPrompt: () => void;
  dismissPreservedPrompt: () => void;
  /**
   * 旧 Chat Doc 初始同步未完成：缺失文档、原因与尺寸上限。
   * 非 null 时必须展示明确恢复状态，不能把空历史当作“该会话没有历史”。
   */
  historyRecovery: YjsHistoryIncomplete | null;
  /** 历史恢复重试已发起、完整快照尚未到达；横幅据此禁用重复点击并展示进行中状态。 */
  historyRecoveryRetrying: boolean;
  /** 同步已回退且旧通道历史不完整：阻止发送，恢复入口由 historyRecovery 横幅提供。 */
  syncDegradedBlocked: boolean;
  /** 重建旧 Yjs 连接，重新尝试历史同步。 */
  retryHistoryRecovery: () => void;
  /** 非终态断开后的自动重连标记：UI 展示轻提示而非整屏「已断开」。 */
  autoReconnecting: boolean;
  /**
   * 最近一次终态关闭的 UI 语义码（策略表的 `uiCode`），非终态断开或新连接开始时为 null。
   *
   * 为什么单列一项而不是复用 `classifiedError`：`uiCode` 描述的是**连接为什么结束**（用户主动停止、
   * 实例被回收…），与「服务端发过哪个公开错误」是两回事——4001/4002 这类关闭不带 error 帧，
   * 事件到达时也不产生错误对象。渲染层据此区分「预期内终态」与「故障」（见 ChatPanel 分支）。
   */
  terminalUiCode: TerminalWsUiCode | null;
  /** RCS session id（Y.Doc 命名用），未就绪时为 undefined。 */
  rcsSessionKey: string | undefined;
  /** 会话/投影换代键：包含 DocHub replacementVersion，用于重置首屏历史窗口。 */
  historyScopeKey: string;
  chatState: ReturnType<typeof useChatState>["state"];
  sessionState: ReturnType<typeof useSessionState>["state"];
  /** 默认启用的新消息投影；明确拒绝时保留旧路径。 */
  syncChat: ReturnType<typeof useSyncChatState>;
  periTasks: PeriTaskViewsResult["state"]["tasks"];
  periTasksLoaded: boolean;
  /** 待发送队列投影（Session Doc `userInputQueue` 子树；未启用时为 enabled=false） */
  userInputQueue: UserInputQueueView;
  derivedState: ChatPanelDerivedState;
  callbacks: ChatPanelCallbacks;
}
