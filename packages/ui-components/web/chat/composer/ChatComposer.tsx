import { X } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import type { AvailableCommand, ChatInputMessage, FileAttachment, SessionMode } from "../types";
import { CommandMenu, type McpOption } from "./CommandMenu";
import { ComposerAssets, type ComposerQuote } from "./composer-assets";
import type { ComposerExternalSubscribe } from "./composer-effects";
import type { ComposerFileInfo, CompressImage, UploadComposerFiles } from "./composer-file-processing";
import { type ComposerNoticeHandler, useComposerHandlers } from "./composer-handlers";
import { type ComposerState, useComposerState } from "./composer-state";
import { ComposerToolbar } from "./composer-toolbar";
import { removeSlashCommand } from "./internal/remove-slash-command";
import { useDragUpload } from "./useDragUpload";

/**
 * ChatComposer — 玻璃磨砂命令岛输入组件。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/ChatComposer.tsx`（597 行）。
 * 拆分说明（500 行红线）：输入状态切到 `./composer-state.ts`，事件处理器切到
 * `./composer-handlers.ts`（其内部再用 `./composer-effects.ts` 订阅外部输入）；
 * 本文件只保留 props、状态装配与渲染结构——渲染结构、类名、文案插值与源实现逐字一致。
 *
 * 纯化改动点（业务与传输耦合剥离为 props）：
 * - 宿主 `FilePickerDialog` → `renderFilePicker` 渲染 prop（源 `envId` prop 随之去掉：
 *   文件引用能力改为以「是否提供 `renderFilePicker` / `uploadFiles`」判定）。
 * - 3 个 window CustomEvent（`chat:apply-suggested-prompt` / `file-tree:reference` /
 *   `chat:quote`）→ 统一的 `subscribeExternal` 通道（会话/环境作用域过滤上移到宿主）。
 * - `@/src/api/fs`（`uploadChatFiles` / `getChatUploadPath` / `fsApi`）与 `@/src/api/request`
 *   → `uploadFiles` 回调；`browser-image-compression` → `compressImage` 回调；
 *   `sonner` toast → `onNotice` 回调；`@/src/lib/context-queue` → `../lib/context-queue`；
 *   `@fenix/chat-channel` 与 `@/src/lib/types` 的类型 → 包内 `../types`。
 * - 输入状态半受控：`draft` / `attachments` / `quotes` / `commandPanelOpen` 传入即由宿主接管。
 */

/** `renderFilePicker` 的渲染参数：宿主据此渲染自己的文件选择器（源实现直接 import 宿主组件）。 */
export interface ComposerFilePickerRenderProps {
  open: boolean;
  onClose: () => void;
  onSelect: (file: ComposerFileInfo) => void;
}

/** ChatComposer 属性 — 新玻璃磨砂命令岛输入组件 */
export interface ChatComposerProps {
  onSubmit: (message: ChatInputMessage) => void;
  isLoading?: boolean;
  onInterrupt?: () => void;
  /** turn 是否可中断（accepting/running/awaiting_permission），仅驱动停止按钮；默认 false */
  canCancel?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** 是否支持图片上传 */
  supportsImages?: boolean;
  /** Agent 提供的可用 slash 命令（宿主常传 readonly 派生态，故按只读数组接收） */
  commands?: readonly AvailableCommand[];
  /** 当前 Agent 已绑定的 MCP，只作为本轮上下文候选。 */
  mcps?: readonly McpOption[];
  /** 确定性会话标识，用于隔离 keep-alive Chat 的引用上下文。 */
  contextScope?: string;
  /** 当前模型名称（通过 Chat Doc 同步） */
  modelName?: string;
  /** 可用会话模式列表 */
  availableModes?: SessionMode[];
  /** 当前会话模式 ID（Task 5 元信息条用到） */
  currentModeId?: string | null;
  /** 模式切换回调（Task 5 元信息条用到） */
  onModeChange?: (modeId: string) => void;
  /** ACP 报告的当前上下文用量与窗口容量。 */
  contextUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; contextWindow?: number } | null;
  /** 新建会话回调（Task 5 元信息条用到） */
  onNewSession?: () => void;
  /** 是否显示新建会话按钮（Task 5 元信息条用到） */
  showNewSession?: boolean;
  className?: string;
  /** 上传回调（纯化替代宿主 api 客户端直连）；缺省时禁用普通附件选择与拖拽上传。 */
  uploadFiles?: UploadComposerFiles;
  /** 图片压缩回调（纯化替代 `browser-image-compression`）；缺省时不压缩，直接按原图编码。 */
  compressImage?: CompressImage;
  /** 文件选择器渲染入口（纯化替代宿主 `FilePickerDialog`）；缺省时不渲染 `@` 引用入口。 */
  renderFilePicker?: (props: ComposerFilePickerRenderProps) => ReactNode;
  /** 外部输入订阅（纯化替代 3 个 window 事件监听）。 */
  subscribeExternal?: ComposerExternalSubscribe;
  /** 提示回调（纯化替代 sonner toast）。 */
  onNotice?: ComposerNoticeHandler;
  /** 受控草稿文本；传入时组件不再自持文本状态。 */
  draft?: string;
  /** 非受控草稿初始值（受控时忽略）。 */
  defaultDraft?: string;
  onDraftChange?: (text: string) => void;
  /** 受控待发送附件列表。 */
  attachments?: FileAttachment[];
  onAttachmentsChange?: (attachments: FileAttachment[]) => void;
  /** 受控待发送引用列表。 */
  quotes?: ComposerQuote[];
  onQuotesChange?: (quotes: ComposerQuote[]) => void;
  /** 受控命令/能力面板开关。 */
  commandPanelOpen?: boolean;
  onCommandPanelOpenChange?: (open: boolean) => void;
}

export function ChatComposer({
  onSubmit,
  isLoading = false,
  onInterrupt,
  canCancel = false,
  disabled = false,
  placeholder,
  supportsImages = false,
  commands,
  mcps = [],
  contextScope,
  availableModes,
  currentModeId,
  onModeChange,
  contextUsage,
  onNewSession,
  showNewSession,
  modelName,
  className,
  uploadFiles,
  compressImage,
  renderFilePicker,
  subscribeExternal,
  onNotice,
  draft,
  defaultDraft,
  onDraftChange,
  attachments: controlledAttachments,
  onAttachmentsChange,
  quotes: controlledQuotes,
  onQuotesChange,
  commandPanelOpen: controlledCommandPanelOpen,
  onCommandPanelOpenChange,
}: ChatComposerProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const _placeholder = placeholder ?? t("chat.components.chatInput.placeholder");

  // 发送/停止按钮派生状态（与 loading 正交）：
  // - canCancel（accepting/running/awaiting_permission）→ 显示停止图标且可点击（停止可用性
  //   不依赖 loading：running 输出期间 loading 虽非空，仍不能退回 Send，保证可中断）；
  // - isCancelling（isLoading 且不可取消 ⟺ turn === cancelling，取消已发出）→ 显示停止但禁用，
  //   防止重复点触发无意义的重发 cancel RPC；
  // - 其余状态 → 发送按钮，按 canSend 决定可点。
  const isCancelling = isLoading && !canCancel;

  // ---------------------------------------------------------------------------
  // 输入状态 — 半受控（源为组件内部 state，见 ./composer-state.ts）
  // ---------------------------------------------------------------------------
  const state: ComposerState = useComposerState({
    commands,
    contextScope,
    draft,
    defaultDraft,
    onDraftChange,
    attachments: controlledAttachments,
    onAttachmentsChange,
    quotes: controlledQuotes,
    onQuotesChange,
    commandPanelOpen: controlledCommandPanelOpen,
    onCommandPanelOpenChange,
  });
  const {
    text,
    setText,
    images,
    attachments,
    quotes,
    selectedMcpIds,
    toggleMcp,
    selectedCommandNames,
    commandPanelOpen,
    commandPanelSearch,
    commandFilter,
    openCommandPanelSearch,
    closeCommandPanel,
    removeImage,
    removeAttachment,
    addAttachments,
  } = state;

  // ---------------------------------------------------------------------------
  // Refs — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---------------------------------------------------------------------------
  // Handlers / 外部输入 — 见 ./composer-handlers.ts
  // ---------------------------------------------------------------------------
  const handlers = useComposerHandlers({
    state,
    commands,
    mcps,
    disabled,
    isLoading,
    supportsImages,
    uploadFiles,
    compressImage,
    fileReferenceEnabled: Boolean(renderFilePicker),
    onSubmit,
    onNewSession,
    onNotice,
    subscribeExternal,
    textareaRef,
    fileInputRef,
  });

  // 拖拽文件上传 hook
  const {
    isDragOver,
    isUploading,
    uploadingCount,
    handleDragOver: hookDragOver,
    handleDragEnter: hookDragEnter,
    handleDragLeave: hookDragLeave,
    handleDrop: hookDrop,
  } = useDragUpload({
    uploadFiles,
    onUploaded: handlers.handleFilePickerSelect,
    onError: (message) => onNotice?.({ level: "error", message }),
    disabled,
  });

  // ---------------------------------------------------------------------------
  // canSend 计算 — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------
  const canSend = (text.trim() || images.length > 0 || attachments.length > 0 || quotes.length > 0) && !disabled;

  // ---------------------------------------------------------------------------
  // Render — 玻璃磨砂容器 + 大 textarea + 底部脚标行
  // ---------------------------------------------------------------------------
  return (
    <div
      className={`chat-composer-wrapper w-full max-w-3xl mx-auto px-4 sm:px-8 pb-4 pt-2${className ? ` ${className}` : ""}`}
    >
      <div className="relative">
        {commandPanelOpen && ((commands?.length ?? 0) > 0 || mcps.length > 0) && (
          <CommandMenu
            commands={commands ?? []}
            mcps={commandPanelSearch ? mcps : []}
            selectedCommandNames={selectedCommandNames}
            selectedMcpIds={selectedMcpIds}
            filter={commandFilter}
            showSearch={commandPanelSearch}
            onSelect={handlers.handleCommandSelect}
            onToggleMcp={toggleMcp}
            onClose={closeCommandPanel}
            className="chat-command-menu--panel"
          />
        )}

        <div
          className={`chat-composer-card${isDragOver ? " bg-brand/5 shadow-[inset_0_0_0_2px_var(--color-brand)]" : ""}`}
          onDragOver={hookDragOver}
          onDragEnter={hookDragEnter}
          onDragLeave={hookDragLeave}
          onDrop={(e) => {
            hookDrop(e);
            // 保留文件树拖拽路径引用逻辑
            const treePath = e.dataTransfer.getData("text/plain");
            if (!treePath || treePath.startsWith("file://") || treePath.startsWith("blob:")) return;
            e.preventDefault();
            const name = treePath.split("/").pop() || treePath;
            const cleanPath = treePath.endsWith("/") ? treePath.slice(0, -1) : treePath;
            setText((prev) => `${prev}@./${cleanPath} `);
            addAttachments([{ name, path: cleanPath }]);
            textareaRef.current?.focus();
          }}
        >
          {/* File Picker：宿主渲染入口（源实现直接渲染宿主 FilePickerDialog） */}
          {handlers.showFilePicker && renderFilePicker
            ? renderFilePicker({
                open: handlers.showFilePicker,
                onClose: handlers.closeFilePicker,
                onSelect: handlers.handleFilePickerSelect,
              })
            : null}

          <ComposerAssets
            images={images}
            files={attachments}
            quotes={quotes}
            onRemoveImage={removeImage}
            onRemoveFile={removeAttachment}
            onRemoveQuote={handlers.removeQuote}
          />

          {(selectedCommandNames.size > 0 || selectedMcpIds.size > 0) && (
            <div
              className="chat-composer-capabilities"
              role="group"
              aria-label={t("chat.components.commandMenu.selectedCapabilities")}
            >
              {Array.from(selectedCommandNames).map((name) => (
                <button
                  key={`skill:${name}`}
                  type="button"
                  onClick={() => setText((current) => removeSlashCommand(current, name))}
                >
                  /{name}
                  <X />
                </button>
              ))}
              {mcps
                .filter((mcp) => selectedMcpIds.has(mcp.id))
                .map((mcp) => (
                  <button key={`mcp:${mcp.id}`} type="button" className="is-mcp" onClick={() => toggleMcp(mcp)}>
                    MCP: {mcp.name}
                    <X />
                  </button>
                ))}
            </div>
          )}

          <div className="px-4 pt-4 pb-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handlers.handleInput}
              onKeyDown={handlers.handleKeyDown}
              onPaste={handlers.handlePaste}
              placeholder={_placeholder}
              disabled={disabled}
              rows={1}
              className="chat-composer-textarea w-full resize-none border-none bg-transparent outline-none text-sm text-text-primary placeholder:text-text-muted min-h-[58px] max-h-[200px] leading-relaxed"
            />
          </div>

          <ComposerToolbar
            commands={commands}
            mcpCount={mcps.length}
            disabled={disabled}
            isLoading={isLoading}
            canCancel={canCancel}
            isCancelling={isCancelling}
            canSend={Boolean(canSend)}
            supportsAttachments={supportsImages || Boolean(uploadFiles)}
            fileInputRef={fileInputRef}
            onFileSelect={() => void handlers.handleFileSelect()}
            commandPanelOpen={commandPanelOpen}
            onCommandPanelOpenChange={(open) => {
              if (open) openCommandPanelSearch();
              else closeCommandPanel();
            }}
            contextUsage={contextUsage}
            availableModes={availableModes}
            currentModeId={currentModeId}
            onModeChange={onModeChange}
            modelName={modelName}
            showNewSession={showNewSession}
            onNewSession={handlers.handleNewSession}
            onSubmit={handlers.handleSubmit}
            onInterrupt={onInterrupt}
          />
        </div>

        {/* 上传进度提示 */}
        {isUploading && (
          <div className="text-center">
            <span className="text-[11px] text-text-muted">
              {t("chat.components.chatComposer.uploadingFiles", { count: uploadingCount })}
            </span>
          </div>
        )}

        {/* 提示文本 */}
        <div className="text-center mt-1.5">
          <span className="text-[11px] text-text-muted">{t("chat.components.chatComposer.hint")}</span>
        </div>
      </div>
    </div>
  );
}
