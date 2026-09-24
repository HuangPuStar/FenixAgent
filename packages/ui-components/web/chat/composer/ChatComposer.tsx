import "./ChatComposer.css";

import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { RemovableChip } from "../../components/RemovableChip";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import type { AvailableCommand, ChatInputMessage, SessionMode } from "../types";
import { CommandMenu, type McpOption } from "./CommandMenu";
import { ComposerAssets } from "./composer-assets";
import type { ComposerExternalSubscribe } from "./composer-effects";
import type { ComposerFileInfo, CompressImage, UploadComposerFiles } from "./composer-file-processing";
import { type ComposerNoticeHandler, useComposerHandlers } from "./composer-handlers";
import { type ComposerState, type ComposerStateOptions, useComposerState } from "./composer-state";
import { ComposerToolbar } from "./composer-toolbar";
import { removeSlashCommand } from "./internal/remove-slash-command";
import { useDragUpload } from "./useDragUpload";

/**
 * ChatComposer — 玻璃磨砂命令岛输入组件。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/ChatComposer.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）（597 行）。
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

/**
 * 输入岛卡片的宽度容器 —— **输入岛宽度的唯一来源**，贴在输入岛顶部的卡片由它派生。
 *
 * 输入岛的实际宽度由这三个类共同决定，且三者都随根字号走：`max-w-200` = 200 × 0.25rem = 50rem、
 * `px-4` / `max-md:px-2.5` = 4 / 2.5 × 0.25rem。本应用根字号是 13px（`apps/web/src/index.css`
 * 的 base 层），`rem` 刻度整体是 0.8125 倍，所以输入岛宽列下是 `650px - 2 × 13px = 624px`，
 * 而不是按 16px 根字号算出来的 768px。
 *
 * 为什么导出（2026-09-23）：状态面板（`ChatStatusPanel`）此前在 `panels/chat-status-panel.css`
 * 里自带一条 **px 台阶** `min(756px, calc(100% - 64px))`，与输入岛的 rem 刻度不同源——根字号一变，
 * 两者立刻脱钩（当时 756px 比输入岛每侧宽 58px），面板不再是「贴在输入岛顶部」的半圆卡。
 * 修法不是把 756 换成另一个数，而是让顶部卡片的宽度从**这一个**容器派生：先套本类，再按
 * `CHAT_COMPOSER_TOP_CARD_INSET_CLASS` 每侧收进一条台阶（见 `../shell/ChatInterface` 的渲染处）。
 * 于是根字号、宽度上限或内边距怎么变，输入岛与顶部卡片的差都仍是那一条台阶。
 *
 * 契约：只取它的**水平**几何（宽度上限 + 左右内边距 + 居中）；垂直节奏（`pt` / `pb`）由调用处各自给；
 * 顶部卡片与输入岛的差由 `CHAT_COMPOSER_TOP_CARD_INSET_CLASS` 单独表达，不要在本类里加减数字。
 */
export const CHAT_COMPOSER_WIDTH_CLASS = "mx-auto w-full max-w-200 px-4 max-md:px-2.5";

/**
 * 贴在输入岛顶部的卡片（状态面板）相对输入岛的**每侧**内缩台阶：Tailwind spacing 刻度 5
 * = 1.25rem。宿主根字号 13px → 每侧 16.25px，卡片总宽比输入岛窄 32.5px（两侧合计 2.5rem）。
 *
 * 为什么是 padding 而不是「再写一条宽度」：它**叠加**在 `CHAT_COMPOSER_WIDTH_CLASS` 之上，所以
 * 输入岛的 `px-4` / 窄屏 `px-2.5` 怎么变，差都仍是一条台阶——不会像 2026-09-23 修掉的旧实现那样
 * 出现两套口径（面板侧 px 台阶 vs 输入岛侧 rem 刻度）而分叉。
 * 用法：`<div className={CHAT_COMPOSER_WIDTH_CLASS}><div className={CHAT_COMPOSER_TOP_CARD_INSET_CLASS}>卡片</div></div>`
 * （见 `../shell/ChatInterface`）；卡片自身不声明宽度。
 *
 * 改口径只改这一处：当前是「每侧 5」（`px-5`）；若要改成「两侧合计 5」（即每侧 2.5）写 `px-2.5`。
 * 值必须落在 Tailwind 刻度上（0.25 的整数倍），不要用 `[16.25px]` 这类任意值——任意值正是本文件
 * 上一版被根字号甩开的写法。
 */
export const CHAT_COMPOSER_TOP_CARD_INSET_CLASS = "px-5";

/** ChatComposer 属性 — 新玻璃磨砂命令岛输入组件 */
export interface ChatComposerProps extends ComposerStateOptions {
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
  // 半受控输入状态端口（`draft` / `attachments` / `quotes` / `commandPanelOpen` 及其回调）
  // 与 `ComposerStateOptions` 逐字相同，2026-09-22 库内去重后由 `extends` 承接，本文件不再复述。
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
    <div className={`${CHAT_COMPOSER_WIDTH_CLASS} pt-0 pb-3${className ? ` ${className}` : ""}`}>
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
            variant="panel"
          />
        )}

        {/* 玻璃卡片：设计层（原 `.chat-composer-wrapper .chat-composer-card`，特指度 (0,2,0)）在源级联中
            压过宿主补充段，故取值全部按设计层落地；92% 白底、两级投影与暗色覆写（源 `.dark .chat-composer-card`，
            类切换而非媒体查询）都写在本目录 `ChatComposer.css` 的 `.chat-composer-island` 里，含
            「未分层声明压过 `isDragOver` 追加的 `bg-brand/5` 与 inset 阴影」这条级联说明。 */}
        <div
          className={`chat-composer-island relative overflow-visible rounded-2xl border border-slate-200 backdrop-blur-md focus-within:outline-0 [transition:border-color_0.2s_ease,box-shadow_0.2s_ease]${isDragOver ? " bg-brand/5 shadow-[inset_0_0_0_2px_var(--color-brand)]" : ""}`}
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
              className="flex flex-wrap gap-1.25 px-3.5 pt-2.5"
              role="group"
              aria-label={t("chat.components.commandMenu.selectedCapabilities")}
            >
              {Array.from(selectedCommandNames).map((name) => (
                <RemovableChip
                  key={`skill:${name}`}
                  className="chat-composer-capability-chip inline-flex min-h-5.75 cursor-pointer items-center gap-1.25 rounded-md border border-slate-300 bg-slate-100 px-1.75 text-3xs text-blue-900"
                  onRemove={() => setText((current) => removeSlashCommand(current, name))}
                >
                  /{name}
                </RemovableChip>
              ))}
              {mcps
                .filter((mcp) => selectedMcpIds.has(mcp.id))
                .map((mcp) => (
                  <RemovableChip
                    key={`mcp:${mcp.id}`}
                    className="chat-composer-capability-chip inline-flex min-h-5.75 cursor-pointer items-center gap-1.25 rounded-md border border-gray-300 bg-green-50 px-1.75 text-3xs text-emerald-700"
                    onRemove={() => toggleMcp(mcp)}
                  >
                    MCP: {mcp.name}
                  </RemovableChip>
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
              className="min-h-14.5 max-h-50 w-full resize-none border-none bg-transparent font-display text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-muted"
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
            <span className="text-3xs text-text-muted">
              {t("chat.components.chatComposer.uploadingFiles", { count: uploadingCount })}
            </span>
          </div>
        )}

        {/* 提示文本 */}
        <div className="text-center mt-1.5">
          <span className="text-3xs text-text-muted">{t("chat.components.chatComposer.hint")}</span>
        </div>
      </div>
    </div>
  );
}
