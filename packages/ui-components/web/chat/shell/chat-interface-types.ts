/**
 * ChatInterface / ACPMain 的宿主契约类型。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/chat-interface-types.ts`（ChatInterfaceProps /
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
 * chat 会话统计摘要。
 *
 * 复制自 `apps/web/src/lib/chat-stats.ts` 的 `ChatStatsSummary`（字段逐字一致）。
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
  hideContextPanel?: boolean;
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
