/**
 * ChatInterface / ACPMain 的宿主契约类型。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/chat-interface-types.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）（ChatInterfaceProps /
 * ChatInterfaceHandle），并按 G5 纯化要求补充宿主注入的端口类型（ChatNotice / ChatStatsSummary /
 * BoundMcpOption）。
 * 纯化改动点：
 * - `@fenix/chat-channel` 类型改为包内 `../types`；`PromptUsage` 在包内命名为 `TokenUsage`（字段一致）。
 * - 新增宿主注入端口，替代组件内的业务耦合：`boundMcps`（MCP 查询）、`projectEntries`（YJS 消息投影）、
 *   `flushContext`（有状态上下文队列）、`onNotice`（sonner toast）、
 *   `onStatsChange`（`chat:stats` window 事件 + ChatStatsDispatcher），以及 ChatComposer 的上传/压缩/
 *   文件选择器/外部输入订阅端口。
 */

import type { ReactNode } from "react";
import type { ComposerFilePickerRenderProps } from "../composer/ChatComposer";
import type { ComposerExternalSubscribe } from "../composer/composer-effects";
import type { CompressImage, UploadComposerFiles } from "../composer/composer-file-processing";
import type {
  AvailableCommand,
  ChangedFile,
  ChatStateSnapshot,
  ContentBlock,
  PeriTaskViewProjection,
  SessionMode,
  SessionStateSnapshot,
  StructuredMessage,
  ThreadEntry,
  TokenUsage,
} from "../types";

/**
 * 会话可用的 MCP 选项（结构等同源 `@/components/chat/CommandMenu` 的 `McpOption`）。
 *
 * ChatInterface 原本在组件内通过 envApi/agentApi/mcpApi 推导绑定 MCP，纯化后由宿主计算并经
 * `boundMcps` 注入，包内不再持有该查询逻辑。
 */
export interface BoundMcpOption {
  id: string;
  name: string;
  description: string;
}

/**
 * 待发送队列单项的状态（服务端状态机，前端只读，不得自行迁移）。
 *
 * - `queued`：等待发送，可单发/全发/取回；
 * - `dispatching` / `claimed`：已被某次派发认领（发送中），不可重复操作；
 * - `delivered`：已注入 agent 会话（用户气泡由服务端写 Chat Doc），队列区不再展示；
 * - `withdrawn`：已取回（草稿归还输入框），队列区立即移除；
 * - `unknown`：契约外的脏数据，展示但不可操作（保守：宁可不给按钮，也不误发已失效的项）。
 */
export type UserInputQueueItemState = "queued" | "dispatching" | "claimed" | "delivered" | "withdrawn" | "unknown";

/** 待发送队列单项的展示投影（Session Doc `userInputQueue.items` 元素）。 */
export interface UserInputQueueItemView {
  /** 前端生成（UUID）、随入队请求发送的条目标识；单发/取回都以它为键 */
  inputId: string;
  /** 可展示文本（服务端投影的 content，用于摘要） */
  content: string;
  /** 用户提交时的原始草稿（取回时回填输入框；缺失时回填 content） */
  originalDraft?: string;
  state: UserInputQueueItemState;
}

/**
 * Session Doc `userInputQueue` 的展示投影。
 *
 * 队列是**服务端唯一事实源**（Y.Doc 子树），前端只读投影、不另建本地队列状态：入队/单发/全发/取回
 * 都只发出控制面 action，界面等 Y.Doc 回推后自然收敛（与用户消息由服务端写 Chat Doc 同一口径）。
 */
export interface UserInputQueueView {
  /** 服务端下发的开关（与能力位同时为真才启用新交互，见 `ChatInterfaceProps.supportsUserInputQueue`） */
  enabled: boolean;
  generation: string | null;
  revision: number;
  /** 当前正在处理的派发请求标识（服务端语义；前端只读展示不做门控） */
  activeRequestId: string | null;
  /** 待展示项（`delivered` / `withdrawn` 已在投影层剔除），保持 Session Doc 中的顺序 */
  items: readonly UserInputQueueItemView[];
}

/**
 * 入队请求（ChatInterface → 宿主）。
 *
 * `inputId` 不在请求内：它由宿主侧出站层生成（`randomUUID`，与 `commandId` 同一处），
 * 界面通过 Y.Doc 回推的队列项拿到标识。
 */
export interface UserInputQueueEnqueueRequest {
  /** 本次提交归一化后的 ACP 内容块（正文 + 附件引用 + 图片 + 引用/上下文注入） */
  content: ContentBlock[];
  /** 用户原始草稿正文（取回时回填输入框） */
  originalDraft?: string;
}

/**
 * chat 会话统计摘要。
 *
 * 复制自 `apps/web/src/lib/chat-stats.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除） 的 `ChatStatsSummary`（字段逐字一致）。
 * 原实现由 `ChatStatsDispatcher` 经 window `chat:stats` 事件派发（1s trailing 节流 + 幂等跳过），
 * 纯化后改为 `onStatsChange` 回调；节流与幂等由宿主决定（宿主可继续复用 `ChatStatsDispatcher`）。
 */
export interface ChatStatsSummary {
  agentName: string | undefined;
  modelName: string | undefined;
  entryCount: number;
  changedFiles: ChangedFile[];
}

/**
 * 组件向外抛出的运行时提示（替代 sonner toast，宿主自行决定展示方式）。
 *
 * 级别取 `../composer/composer-handlers` 的 `ComposerNotice` 超集：shell 自身使用 `warning`
 * （源 `toast.warning`），Composer 使用 `info` / `error`，因此可原样透传给 `ChatComposer.onNotice`。
 */
export interface ChatNotice {
  level: "info" | "warning" | "error";
  message: string;
}

/** ChatInterface 属性。复制自源 `chat-interface-types.ts`，字段名保持一致。 */
export interface ChatInterfaceProps {
  agentId?: string;
  readonly?: boolean;
  rcsSessionId?: string;
  detailSessionId?: string;
  /**
   * 活跃会话变化回调（首条消息懒创建、切换会话、服务端恢复都会触发）。
   * 原本组件还会把会话 ID 写入 localStorage（键 `acp_last_session_<agentId>`），该持久化属宿主策略，
   * 已移出组件：宿主可在此回调中自行落盘。
   */
  onSessionCreated?: (sessionId: string) => void;
  scenePrompt?: string;
  onPromptComplete?: () => void;
  contextKey?: string;
  sessionState?: SessionStateSnapshot | null;
  chatState?: ChatStateSnapshot;
  onSendPrompt: (contentBlocks: ContentBlock[]) => Promise<void>;
  onCancel: () => void;
  onCreateSession: () => Promise<void>;
  onRespondPermission: (requestId: string, optionId: string | null) => void;
  onRespondQuestion: (questionId: string, answers: Array<string | string[]>) => void;
  availableCommands: AvailableCommand[];
  availableModes: SessionMode[];
  currentModeId: string | null;
  onSetMode: (modeId: string) => void;
  supportsModeSelection: boolean;
  supportsImages: boolean;
  modelName: string | undefined;
  tokenUsage?: TokenUsage | null;
  periTasks?: readonly PeriTaskViewProjection[];
  periTasksLoaded?: boolean;
  /**
   * Peri Task 详情抽屉注入槽。
   *
   * 抽屉组件（`PeriTask*` 三件套）按收录范围未进本包（见 README「收录范围」），因此详情入口以注入槽保留：
   * 点击任务行时本组件把选中的 `PeriTaskViewProjection` 与关闭回调交给宿主渲染的抽屉，详情数据的加载
   * 也由宿主负责。未提供时任务行只读（`ChatStatusPanel` 的 tasks Tab 仍正常显示）。
   */
  renderPeriTaskDetail?: (task: PeriTaskViewProjection, close: () => void) => ReactNode;
  connectionState?: string;
  /** 已绑定到当前 agent 的 MCP 列表（宿主查询后注入，替代包内 envApi/agentApi/mcpApi 调用） */
  boundMcps?: readonly BoundMcpOption[];
  /**
   * `sessionState.structuredMessages` → 渲染条目 `ThreadEntry[]` 的投影函数。
   * 源实现直接调用宿主 `@/src/lib/structured-to-thread`（依赖 YJS doc 助手与 i18n 单例，属传输/持久化层，
   * 未复制进包），改为宿主注入；未提供时渲染条目为空。
   */
  projectEntries?: (structuredMessages: readonly StructuredMessage[]) => ThreadEntry[];
  /**
   * 取出并清空当前作用域的上下文队列（源为宿主 `@/src/lib/context-queue` 的 `flushContext`）。
   * 该队列是有状态模块级 Map（`pushContext` / `removeContext` 由宿主页面与 composer 调用），未随纯函数
   * 复制进包内；未提供时本次提交不注入上下文块。
   */
  flushContext?: (scope?: string) => string | null;
  /** 运行时提示出口（替代 sonner toast） */
  onNotice?: (notice: ChatNotice) => void;

  // ── 待发送队列（peri steer 交互：运行中提交入队，可单发/全发/取回）──
  /**
   * 能力位 `capabilities['peri.userInputQueue']`（宿主从 Session Doc `agent.capabilities` 派生）。
   * 与 `userInputQueue.enabled` 同时为真时才启用入队交互；任一为假时的一切提交维持直发 `send_prompt`。
   */
  supportsUserInputQueue?: boolean;
  /**
   * Session Doc `userInputQueue` 投影（宿主订阅派生，见 `@fenix/agent-runtime/web/hooks/use-user-input-queue`）。
   * 未注入或未启用时队列区不渲染，提交按钮/回车保持原行为。
   */
  userInputQueue?: UserInputQueueView | null;
  /**
   * 入队（控制面 `enqueue_user_input`）：不打断当前执行，把这条提交挂到待发送队列。
   * 返回是否真正写入 socket；`false` 时本组件给出可重试提示，草稿内容保留在重试入口里。
   */
  onEnqueueUserInput?: (request: UserInputQueueEnqueueRequest) => boolean;
  /**
   * 单发/全发（控制面 `dispatch_user_inputs`）：把指定待发送项打断注入当前执行。
   * 传单个 id 即「单发」，传全部 queued 项即「全部发送」。返回是否真正写入 socket。
   */
  onDispatchUserInputs?: (inputIds: string[]) => boolean;
  /** 取回（控制面 `takeback_user_input`）：撤销待发送项并归还草稿。返回是否真正写入 socket。 */
  onTakebackUserInput?: (inputId: string) => boolean;

  /** 会话统计摘要出口（替代 `chat:stats` window 事件 + ChatStatsDispatcher） */
  onStatsChange?: (stats: ChatStatsSummary) => void;
  /**
   * 打开 workspace 文件（宿主注入，替代 `artifacts:preview-file` window 事件总线）。
   *
   * 源实现中工具卡片与状态面板各自 `window.dispatchEvent(new CustomEvent("artifacts:preview-file", …))`，
   * 由宿主的 artifacts 面板订阅；纯化后 timeline / panels 层只暴露 `onPreviewFile(path)`，envId 由本层
   * 绑定（与 `ChatView` 的 `onOpenWorkspaceFile` 契约一致）。未提供时，点击文件不产生跳转。
   */
  onOpenWorkspaceFile?: (envId: string, path: string) => void;

  // ── ChatComposer 宿主端口（原样透传，见 `../composer/ChatComposer` 的纯化说明）──
  /** 上传回调（替代宿主 api 客户端直连）；缺省时禁用普通附件选择与拖拽上传 */
  uploadFiles?: UploadComposerFiles;
  /** 图片压缩回调（替代 `browser-image-compression`）；缺省时按原图编码 */
  compressImage?: CompressImage;
  /** 文件选择器渲染入口（替代宿主 `FilePickerDialog`）；缺省时不渲染 `@` 引用入口 */
  renderFilePicker?: (props: ComposerFilePickerRenderProps) => ReactNode;
  /** 外部输入订阅（替代 3 个 window 事件监听） */
  subscribeExternal?: ComposerExternalSubscribe;
}

/** ChatInterface 命令式句柄。复制自源 `chat-interface-types.ts`。 */
export interface ChatInterfaceHandle {
  newSession: () => void;
  /** 当前是否正在等待 agent 响应。 */
  isLoading: boolean;
}
