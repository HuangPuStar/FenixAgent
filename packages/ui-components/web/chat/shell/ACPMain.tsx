import { Plus } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";
import { ScrollArea } from "../../ui/scroll-area";
import type { ComposerFilePickerRenderProps } from "../composer/ChatComposer";
import type { ComposerExternalSubscribe } from "../composer/composer-effects";
import type { CompressImage, UploadComposerFiles } from "../composer/composer-file-processing";
import type {
  AvailableCommand,
  ChatStateSnapshot,
  ContentBlock,
  PeriTaskViewProjection,
  SessionMode,
  SessionStateSnapshot,
  StructuredMessage,
  ThreadEntry,
} from "../types";
import { ChatHeader } from "./ChatHeader";
import { ChatInterface, type ChatInterfaceHandle } from "./ChatInterface";
import type {
  BoundMcpOption,
  ChatNotice,
  ChatSpaceItem,
  ChatStatsSummary,
  SessionCreateReceipt,
} from "./chat-interface-types";
import { AcpMainMobileSidebar } from "./internal/acp-main-mobile-sidebar";
import { useAcpSessionBootstrap } from "./internal/use-acp-session-bootstrap";
import { useSpaceActionRunner } from "./internal/use-space-action-runner";
import { SessionSelectFallbackProvider, SidebarSessionList } from "./sidebar-session-list";

/**
 * ACPMain 属性。复制自 `packages/chat-channel/web/components/ACPMain.tsx`（旧路径，已于 2026-09-21 由 8f364c109 删除）。
 * 纯化改动点：`sidebarOpen` / `onSidebarOpenChange` 取代 localStorage `acp-sidebar-open`；
 * `onNotice` 取代 sonner toast；并把宿主端口（`boundMcps` / `projectEntries` / `flushContext` /
 * Composer 上传相关回调 / `onStatsChange` / `onOpenWorkspaceFile`）透传给 ChatInterface。
 */
interface ACPMainProps {
  agentId?: string;
  readonly?: boolean;
  hideSidebar?: boolean;
  rcsSessionId?: string;
  /** 服务端确定性计算 rcsSessionId 使用的实例会话标识 */
  detailSessionId?: string;
  scenePrompt?: string;
  contextKey?: string;
  onPromptComplete?: () => void;
  chatState?: ChatStateSnapshot;
  sessionState?: SessionStateSnapshot | null;
  connectionState?: string;

  // ── 出站操作回调（替代 client 方法）──
  onSendPrompt: (contentBlocks: ContentBlock[]) => Promise<void> | void;
  onCancel: () => void;
  onCreateSession: () => SessionCreateReceipt | Promise<SessionCreateReceipt>;
  onLoadSession: (sessionId: string) => void;
  onResumeSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onRespondPermission: (requestId: string, optionId: string | null) => void;
  /** AskUserQuestion 答案回传（按问题顺序；多选题答案为 string[]） */
  onRespondQuestion: (questionId: string, answers: Array<string | string[]>) => void;

  // ── 状态 props（替代 client.state / client.xxx 读取）──
  supportsImages?: boolean;
  supportsLoadSession?: boolean;
  supportsResumeSession?: boolean;
  availableCommands?: AvailableCommand[];
  availableModes?: SessionMode[];
  currentModeId?: string | null;
  onSetMode?: (modeId: string) => void;
  supportsModeSelection?: boolean;
  modelName?: string;
  tokenUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; contextWindow?: number } | null;

  // ── Peri Task 视图（切片 2，会话活动面板）──
  /** Session Doc tasks/taskOrder 派生任务视图（非终态在前排序，引用稳定） */
  periTasks?: readonly PeriTaskViewProjection[];
  /** tasks/taskOrder 子树是否已同步（未同步时任务面板显示加载态） */
  periTasksLoaded?: boolean;
  /** Peri Task 详情抽屉注入槽（透传给 ChatInterface，见 `chat-interface-types`） */
  renderPeriTaskDetail?: (task: PeriTaskViewProjection, close: () => void) => ReactNode;

  // ── 纯化新增端口 ──
  /**
   * 桌面侧边栏展开状态（受控）。不传时为非受控、默认展开。
   * 源实现把该状态持久化在 localStorage 键 `acp-sidebar-open`，持久化已移交宿主。
   */
  sidebarOpen?: boolean;
  /** 侧边栏展开状态变化回调（宿主可在此持久化，如写入 localStorage `acp-sidebar-open`） */
  onSidebarOpenChange?: (open: boolean) => void;
  /** 已绑定 MCP 列表（透传给 ChatInterface，替代包内 envApi/agentApi/mcpApi 查询） */
  boundMcps?: readonly BoundMcpOption[];
  /** `StructuredMessage[]` → `ThreadEntry[]` 投影（透传给 ChatInterface，由宿主注入） */
  projectEntries?: (structuredMessages: readonly StructuredMessage[]) => ThreadEntry[];
  /** 上下文队列取出并清空（透传给 ChatInterface，源为宿主 `@/src/lib/context-queue.flushContext`） */
  flushContext?: (scope?: string) => string | null;
  /** ChatComposer 宿主端口（原样透传给 ChatInterface，见 `../composer/ChatComposer`） */
  uploadFiles?: UploadComposerFiles;
  /** 图片压缩回调（透传） */
  compressImage?: CompressImage;
  /** 文件选择器渲染入口（透传） */
  renderFilePicker?: (props: ComposerFilePickerRenderProps) => ReactNode;
  /** 外部输入订阅（透传） */
  subscribeExternal?: ComposerExternalSubscribe;
  /** 运行时提示出口（透传给 ChatInterface，替代 sonner toast） */
  onNotice?: (notice: ChatNotice) => void;
  /**
   * 打开工作区文件（透传给 ChatInterface）：用户消息正文中的 `@./path` 引用与状态面板的
   * 变更文件行都用它。源实现经宿主的预览事件总线派发；未注入时点击文件不产生跳转。
   */
  onOpenWorkspaceFile?: (envId: string, path: string) => void;
  /** 会话统计摘要出口（透传给 ChatInterface，替代 window `chat:stats` 事件） */
  onStatsChange?: (stats: ChatStatsSummary) => void;

  // ── space 分组（会话空间树）──
  /**
   * 空间列表（顺序即侧栏分组顺序）。**未注入时侧栏保持「今天/昨天/更早」时间分组**；
   * 注入后第一组固定为「默认」（未归属会话），`[]` 与 `undefined` 语义不同（未接入 vs 已加载为空）。
   */
  spaces?: readonly ChatSpaceItem[];
  /** space 数据是否已加载完成；false 且无会话时侧栏保持 loading 态 */
  spacesLoaded?: boolean;
  /** 分组列表加载失败（侧栏给可重试提示，不退回时间分组掩掉失败） */
  spacesError?: boolean;
  /** 重取分组列表（失败提示里的重试入口） */
  onRefreshSpaces?: () => void;
  /** 新建空间（名称已 trim）；space 数据的刷新由宿主负责 */
  onCreateSpace?: (name: string) => void | Promise<void>;
  /** 重命名空间（名称已 trim 且与原值不同）；刷新由宿主负责 */
  onRenameSpace?: (spaceId: string, name: string) => void | Promise<void>;
  /** 会话归属写入：组内新建会话成功后用新会话 id 调用，侧栏拖放落点也走它 */
  onAssignSession?: (spaceId: string, sessionId: string) => void | Promise<void>;
  /** 清除会话归属：会话删除成功后调用，侧栏把会话拖回「默认」分组时也走它 */
  onUnassignSession?: (sessionId: string) => void | Promise<void>;
}

/**
 * Main container — Anthropic sidebar + chat layout.
 * Sidebar: sectioned by recency, orange active state, warm raised bg.
 *
 * 复制自 `packages/chat-channel/web/components/ACPMain.tsx`（旧路径，已于 2026-09-21 由 8f364c109 删除）。
 * 纯化改动点：localStorage `acp-sidebar-open` → 受控 `sidebarOpen` / `onSidebarOpenChange`；
 * sonner `toast.warning` → `onNotice` 回调；UI 组件、类型与 i18n 收敛到包内；
 * 会话 bootstrap 策略（300ms 防抖选最近会话 / 列表确认后自动建会话）逐字保留在
 * `internal/use-acp-session-bootstrap`——本组件只做布局与回调转发。
 */
export function ACPMain({
  agentId,
  readonly,
  hideSidebar,
  rcsSessionId,
  detailSessionId,
  scenePrompt,
  contextKey,
  onPromptComplete,
  chatState,
  sessionState,
  connectionState,
  onSendPrompt,
  onCancel,
  onCreateSession,
  onLoadSession,
  onResumeSession,
  onRenameSession,
  onDeleteSession,
  onRespondPermission,
  onRespondQuestion,
  supportsImages = false,
  supportsLoadSession = false,
  supportsResumeSession = false,
  availableCommands = [],
  availableModes = [],
  currentModeId = null,
  onSetMode = () => {},
  supportsModeSelection = false,
  modelName,
  tokenUsage,
  periTasks = [],
  periTasksLoaded = false,
  renderPeriTaskDetail,
  sidebarOpen: sidebarOpenProp,
  onSidebarOpenChange,
  boundMcps,
  projectEntries,
  flushContext,
  uploadFiles,
  compressImage,
  renderFilePicker,
  subscribeExternal,
  onNotice,
  onStatsChange,
  onOpenWorkspaceFile,
  spaces,
  spacesLoaded,
  spacesError,
  onRefreshSpaces,
  onCreateSpace,
  onRenameSpace,
  onAssignSession,
  onUnassignSession,
}: ACPMainProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  // 侧边栏展开状态：受控/非受控双模（源实现直接读写 localStorage `acp-sidebar-open`，默认打开；
  // 首次访问无记录 → 展开，用户手动收起后由宿主记住选择）。
  const [uncontrolledSidebarOpen, setUncontrolledSidebarOpen] = useState(true);
  const sidebarOpen = sidebarOpenProp ?? uncontrolledSidebarOpen;
  const setSidebarOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(sidebarOpen) : next;
      setUncontrolledSidebarOpen(value);
      onSidebarOpenChange?.(value);
    },
    [sidebarOpen, onSidebarOpenChange],
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const chatRef = useRef<ChatInterfaceHandle>(null);
  const runSpaceAction = useSpaceActionRunner(onNotice);

  // 侧边栏状态的持久化（源为 localStorage `acp-sidebar-open`）已移交宿主：见 `onSidebarOpenChange`。

  // ── Callbacks（直接调用 props 回调）──
  const handleSendPrompt = useCallback(
    async (contentBlocks: ContentBlock[]) => {
      const result = onSendPrompt(contentBlocks);
      if (result instanceof Promise) await result;
    },
    [onSendPrompt],
  );

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  /**
   * 普通新建（ChatHeader / 侧栏头部的 +）：本层不消费回执，但**必须原样透传**——
   * `ChatInterface.newSession` 的返回值就是创建回执，在这里 `await` 后丢掉会让
   * 组内新建（同一句柄的另一条调用路径）拿不到 session id。失败提示在 ChatInterface 内收敛。
   */
  const handleCreateSession = useCallback(async () => await onCreateSession(), [onCreateSession]);

  const handleRespondPermission = useCallback(
    (requestId: string, optionId: string | null) => {
      onRespondPermission(requestId, optionId);
    },
    [onRespondPermission],
  );

  // 用户主动切换会话时收起移动端抽屉（自动恢复不动它）
  const closeMobileSidebar = useCallback(() => setMobileSidebarOpen(false), []);

  // ── 会话引导与切换编排（300ms 防抖选最近会话 / 延迟 activeSessionId / 失败高亮回退）──
  const { sessions, initialActiveSessionId, setInitialActiveSessionId, sessionSelectFallback, handleSelectSession } =
    useAcpSessionBootstrap({
      connectionState,
      chatState,
      chatRef,
      supportsLoadSession,
      supportsResumeSession,
      onLoadSession,
      onResumeSession,
      onNotice,
      handleCreateSession,
      onUserSessionSelected: closeMobileSidebar,
    });

  // ── 组内新建会话：等 ChatInterface 的创建回执，拿到 session id 后才写归属 ──
  const handleCreateSessionInSpace = useCallback(
    async (spaceId: string | null) => {
      const chat = chatRef.current;
      if (!chat) return;
      // 回执是本页本次创建的结果（服务端按 commandId 定向回给本连接）：只要它非空，
      // 这个会话就是本次点击创建出来的，与「共享 active session 为什么变了」无关。
      // 忙碌被拒 / 发送失败 / Agent 拒绝 / 超时时回执为 null，此时不写归属——
      // 用户的意图没有落点，但绝不会有别的标签页的会话被算进这个分组。
      const createdSessionId = await chat.newSession();
      if (!createdSessionId) return;
      // 默认分组（null）不产生归属写：新会话本来就落在默认分组。
      if (spaceId === null) return;
      runSpaceAction(
        "chat.components.acpMain.assignSpaceFailed",
        onAssignSession ? () => onAssignSession(spaceId, createdSessionId) : undefined,
      );
    },
    [onAssignSession, runSpaceAction],
  );

  // 不带分组的普通新建（ChatHeader / 侧栏头部的 +）：不再需要清理归属意图——
  // 归属只由上面这次调用的回执决定，不存在跨调用的待消费状态。
  const handleNewSession = useCallback(() => {
    void chatRef.current?.newSession();
  }, []);

  const handleSessionCreated = useCallback(
    (sessionId: string) => {
      setInitialActiveSessionId(sessionId);
    },
    [setInitialActiveSessionId],
  );

  return (
    // 会话切换失败回退信号在根节点注入一次：侧边栏列表由桌面侧栏、移动端抽屉与 ChatHeader
    // 三处渲染（后两处是包内包装组件，本组件无法逐层透传新 prop），Context 覆盖全部实例。
    <SessionSelectFallbackProvider fallback={sessionSelectFallback}>
      {/* root 加 p-3 gap-3：让顶部 ChatHeader 浮动卡片与下方内容统一外边距，
          形成上下两个玻璃磨砂卡片悬浮在子页面背景上的视觉效果。
          acp-main-root：共享高度链与 ChatHeader 样式的作用域钩子 */}
      <div className="acp-main-root flex h-full w-full min-w-0 min-h-0 flex-col overflow-hidden bg-white text-gray-800">
        {/* 顶部 ChatHeader — 仅展示当前会话标题；会话列表统一从侧边栏进入 */}
        {/* readonly 时整体隐藏 */}
        {!readonly && (
          <ChatHeader
            activeSessionId={initialActiveSessionId}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            onToggleSidebar={
              !hideSidebar
                ? () => {
                    if (window.matchMedia("(max-width: 767px)").matches) {
                      setMobileSidebarOpen((open) => !open);
                    } else {
                      setSidebarOpen((open) => !open);
                    }
                  }
                : undefined
            }
            sidebarOpen={sidebarOpen || mobileSidebarOpen}
            sessions={sessions}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
            onNotice={onNotice}
            showSessionList={false}
          />
        )}

        {!readonly && !hideSidebar && (
          <AcpMainMobileSidebar
            open={mobileSidebarOpen}
            onOpenChange={setMobileSidebarOpen}
            onNewSession={handleNewSession}
            sessions={sessions}
            initialActiveSessionId={initialActiveSessionId}
            onSelectSession={handleSelectSession}
            onRenameSession={onRenameSession}
            onDeleteSession={onDeleteSession}
            onNotice={onNotice}
            spaces={spaces}
            spacesLoaded={spacesLoaded}
            spacesError={spacesError}
            onRefreshSpaces={onRefreshSpaces}
            onCreateSpace={onCreateSpace}
            onRenameSpace={onRenameSpace}
            onAssignSession={onAssignSession}
            onUnassignSession={onUnassignSession}
            onCreateSessionInSpace={handleCreateSessionInSpace}
          />
        )}

        {/* 主体：横向 sidebar + chat */}
        <div className="flex flex-1 min-h-0">
          {/* 左侧 sidebar — 仅在 sidebarOpen 且非 readonly/hideSidebar 时渲染，关闭时完全不占位 */}
          {!readonly && !hideSidebar && sidebarOpen && (
            <div className="hidden w-54.5 border-r border-gray-100 bg-white md:flex flex-col transition-all duration-200 flex-shrink-0">
              {/* 头部：标题 + 新会话按钮 */}
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-xs font-display font-semibold text-text-muted uppercase tracking-widest px-1">
                  {t("chat.components.acpMain.sessions")}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={handleNewSession}
                    className="h-7 w-7 text-text-muted hover:text-brand hover:bg-brand/10"
                    title={t("chat.components.acpMain.newSession")}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* 会话列表。`min-h-0` 不是修饰：本 ScrollArea 根是列向 flex 的子项（`flex-1`），
                  不写它时 `min-height: auto`（CSS 的自动最小尺寸）会把根撑到**整个列表的内容高度**，
                  视口因此与内容等高、永远没有可滚动溢出 —— 表现为「会话一多就滚不动、且看不到滚动条」
                  （实测：侧栏高 863px，45 条会话时 ScrollArea 根被撑到 1494px，视口 clientHeight ==
                  scrollHeight == 1494，滚轮与 `scrollTop` 赋值都无效）。同包另三处 ScrollArea
                  （`internal/acp-main-mobile-sidebar`、`ChatHeader`、`components/agent-master-detail-workspace`）
                  都带 `min-h-0`，此处补齐同一条约定。会话数少时无差别，故只在「无滚动条 → 有滚动条」时暴露。 */}
              <ScrollArea className="flex-1 min-h-0">
                <SidebarSessionList
                  initialActiveSessionId={initialActiveSessionId}
                  onSelectSession={handleSelectSession}
                  sessions={sessions}
                  onRenameSession={onRenameSession}
                  onDeleteSession={onDeleteSession}
                  onNotice={onNotice}
                  spaces={spaces}
                  spacesLoaded={spacesLoaded}
                  spacesError={spacesError}
                  onRefreshSpaces={onRefreshSpaces}
                  onCreateSpace={onCreateSpace}
                  onRenameSpace={onRenameSpace}
                  onAssignSession={onAssignSession}
                  onUnassignSession={onUnassignSession}
                  onCreateSessionInSpace={handleCreateSessionInSpace}
                />
              </ScrollArea>
            </div>
          )}

          {/* 聊天区域 */}
          {/* chat-main-column 是「唯一高度链」的语义钩子：高度链的声明已随 2026-09-28「伪深层」清理
              就近取档到本行工具类与根节点 `acp-main-root`（包内 `web/chat/css/chat-layout.css` 与宿主
              `apps/web/src/pages/agent-panel/chat-layout.css` 同批清空删除，两侧不再有同名规则）。 */}
          <div className="chat-main-column relative flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-white">
            <ChatInterface
              ref={chatRef}
              agentId={agentId}
              readonly={readonly}
              rcsSessionId={rcsSessionId}
              detailSessionId={detailSessionId}
              scenePrompt={scenePrompt}
              contextKey={contextKey}
              onSessionCreated={handleSessionCreated}
              onPromptComplete={onPromptComplete}
              sessionState={sessionState}
              chatState={chatState}
              onSendPrompt={handleSendPrompt}
              onCancel={handleCancel}
              onCreateSession={handleCreateSession}
              onRespondPermission={handleRespondPermission}
              onRespondQuestion={onRespondQuestion}
              availableCommands={availableCommands}
              availableModes={availableModes}
              currentModeId={currentModeId}
              onSetMode={onSetMode}
              supportsModeSelection={supportsModeSelection}
              supportsImages={supportsImages}
              modelName={modelName}
              tokenUsage={tokenUsage}
              connectionState={connectionState}
              periTasks={periTasks}
              periTasksLoaded={periTasksLoaded}
              renderPeriTaskDetail={renderPeriTaskDetail}
              boundMcps={boundMcps}
              projectEntries={projectEntries}
              flushContext={flushContext}
              uploadFiles={uploadFiles}
              compressImage={compressImage}
              renderFilePicker={renderFilePicker}
              subscribeExternal={subscribeExternal}
              onNotice={onNotice}
              onStatsChange={onStatsChange}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          </div>
        </div>
      </div>
    </SessionSelectFallbackProvider>
  );
}
