import type { AvailableCommand, SessionMode } from "@fenix/chat-channel";
import { type ClipboardEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FilePickerDialog } from "../../src/components/FilePickerDialog";
import { pushContext, removeContext } from "../../src/lib/context-queue";
import type { ChatInputMessage, FileAttachment, UserMessageImage } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import type { FileInfo } from "../../src/types";
import { CommandMenu } from "./CommandMenu";
import { ComposerAssets, type ComposerQuote } from "./composer-assets";
import { processImageFiles, uploadComposerFiles } from "./composer-file-processing";
import { ComposerToolbar } from "./composer-toolbar";
import { useDragUpload } from "./useDragUpload";

/** ChatComposer 属性 — 新玻璃磨砂命令岛输入组件 */
interface ChatComposerProps {
  onSubmit: (message: ChatInputMessage) => void;
  isLoading?: boolean;
  onInterrupt?: () => void;
  /** turn 是否可中断（accepting/running/awaiting_permission），仅驱动停止按钮；默认 false */
  canCancel?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** 是否支持图片上传 */
  supportsImages?: boolean;
  /** Agent 提供的可用 slash 命令 */
  commands?: AvailableCommand[];
  /** 环境 ID，用于文件上传/浏览（workspace 按环境隔离） */
  envId?: string;
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
  /** ACP prompt_complete 返回的真实上下文用量；协议未提供上限时不计算百分比。 */
  contextUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null;
  /** 新建会话回调（Task 5 元信息条用到） */
  onNewSession?: () => void;
  /** 是否显示新建会话按钮（Task 5 元信息条用到） */
  showNewSession?: boolean;
  className?: string;
}

/**
 * ChatComposer — 玻璃磨砂命令岛输入组件
 *
 * 从 ChatInput 迁移全部输入逻辑（state/handlers/effects/图片处理/文件拖拽/slash 命令），
 * 重新设计为玻璃磨砂卡片 + 大 textarea 布局。底部元信息条包含：
 * SessionModeSelector / 模型名称 / token 统计 / 新会话 / 发送。
 */
export function ChatComposer({
  onSubmit,
  isLoading = false,
  onInterrupt,
  canCancel = false,
  disabled = false,
  placeholder,
  supportsImages = false,
  commands,
  envId,
  contextScope,
  availableModes,
  currentModeId,
  onModeChange,
  contextUsage,
  onNewSession,
  showNewSession,
  modelName,
  className,
}: ChatComposerProps) {
  const { t } = useTranslation("components");
  const _placeholder = placeholder ?? t("chatInput.placeholder");

  // 发送/停止按钮派生状态（与 loading 正交）：
  // - canCancel（accepting/running/awaiting_permission）→ 显示停止图标且可点击（停止可用性
  //   不依赖 loading：running 输出期间 loading 虽非空，仍不能退回 Send，保证可中断）；
  // - isCancelling（isLoading 且不可取消 ⟺ turn === cancelling，取消已发出）→ 显示停止但禁用，
  //   防止重复点触发无意义的重发 cancel RPC；
  // - 其余状态 → 发送按钮，按 canSend 决定可点。
  const isCancelling = isLoading && !canCancel;
  // ---------------------------------------------------------------------------
  // State — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------
  const [text, setText] = useState("");
  const [images, setImages] = useState<UserMessageImage[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [quotes, setQuotes] = useState<ComposerQuote[]>([]);
  const quoteSequenceRef = useRef(0);

  // ---------------------------------------------------------------------------
  // Refs — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 文件上传和浏览使用 envId（environment ID），后端路由为 /web/environments/:envId/fs
  const fileWorkspaceId = envId;

  // ---------------------------------------------------------------------------
  // Effects — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------

  // 监听文件树引用事件（右键菜单"引用到聊天"）
  useEffect(() => {
    const handler = (e: Event) => {
      const {
        path,
        name,
        envId: referencedEnvId,
      } = (e as CustomEvent<{ path?: unknown; name?: unknown; envId?: unknown }>).detail;
      if (referencedEnvId !== envId || typeof path !== "string" || typeof name !== "string") return;
      setText((prev) => `${prev}@./${path} `);
      setAttachments((prev) => {
        if (prev.some((a) => a.path === path)) return prev;
        return [...prev, { name, path }];
      });
      textareaRef.current?.focus();
    };
    window.addEventListener("file-tree:reference", handler);
    return () => window.removeEventListener("file-tree:reference", handler);
  }, [envId]);

  useEffect(() => {
    const handleQuote = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown; contextScope?: unknown }>).detail;
      if (!contextScope || detail?.contextScope !== contextScope) return;
      const text = detail?.text;
      if (typeof text !== "string" || !text.trim()) return;
      quoteSequenceRef.current += 1;
      const id = `chat-quote-${Date.now()}-${quoteSequenceRef.current}`;
      const normalized = text.replace(/\s+/g, " ").trim();
      pushContext(id, `${t("composerAssets.quoteContext")}\n${normalized}`, contextScope);
      setQuotes((current) => [...current, { id, text: normalized }]);
      textareaRef.current?.focus();
    };
    window.addEventListener("chat:quote", handleQuote);
    return () => window.removeEventListener("chat:quote", handleQuote);
  }, [contextScope, t]);

  // ---------------------------------------------------------------------------
  // Handlers — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0 && attachments.length === 0 && quotes.length === 0) || disabled) return;

    onSubmit({
      text: trimmed,
      images: images.length > 0 ? images : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setText("");
    setImages([]);
    setAttachments([]);
    setQuotes([]);
    setShowCommandMenu(false);
    setCommandFilter("");
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, images, attachments, quotes, disabled, onSubmit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showCommandMenu) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShowCommandMenu(false);
          return;
        }
        // Arrow keys and Enter are handled by CommandMenu via document-level listener
        // Don't submit or move cursor when menu is open
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter") {
          e.preventDefault();
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          setShowCommandMenu(false);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (isLoading) {
          // Loading 时不通过 Enter 中断，需点击停止按钮
          return;
        }
        handleSubmit();
      }
    },
    [handleSubmit, isLoading, showCommandMenu],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setText(value);

      // 检测 slash 命令模式：仅在输入开头输入 / 且还未输入参数时触发
      if (value.startsWith("/") && commands && commands.length > 0) {
        const parts = value.slice(1).split(/\s/);
        // 只在输入命令名阶段（没有空格后跟参数）才显示菜单
        if (parts.length <= 1) {
          setShowCommandMenu(true);
          setCommandFilter(parts[0] || "");
        } else {
          setShowCommandMenu(false);
          setCommandFilter("");
        }
      } else if (showCommandMenu) {
        setShowCommandMenu(false);
        setCommandFilter("");
      }

      // 检测 @ 文件引用触发
      if (fileWorkspaceId && value.endsWith("@")) {
        const prevChar = value.length > 1 ? value[value.length - 2] : " ";
        if (prevChar === " " || value.length === 1) {
          setShowFilePicker(true);
        }
      }

      // 自动调整高度
      const el = e.target;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    },
    [commands, showCommandMenu, fileWorkspaceId],
  );

  // 粘贴图片
  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      if (!supportsImages) return;
      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;

      e.preventDefault();
      const newImages = await processImageFiles(files);
      setImages((prev) => [...prev, ...newImages]);
    },
    [supportsImages],
  );

  // 选择文件（图片走 base64，其他文件上传到 workspace 根目录）
  const _handleFileSelect = useCallback(async () => {
    if (!fileInputRef.current) return;
    const files = fileInputRef.current.files;
    if (!files || files.length === 0) return;

    const imageFiles: File[] = [];
    const otherFiles: File[] = [];

    for (const f of Array.from(files)) {
      if (f.type.startsWith("image/")) {
        imageFiles.push(f);
      } else {
        otherFiles.push(f);
      }
    }

    // 图片：走 base64 压缩流程
    if (imageFiles.length > 0) {
      const newImages = await processImageFiles(imageFiles);
      setImages((prev) => [...prev, ...newImages]);
    }

    // 非图片：上传到 workspace 根目录并添加为附件引用。
    if (otherFiles.length > 0 && fileWorkspaceId) {
      try {
        const newAttachments = await uploadComposerFiles(fileWorkspaceId, otherFiles);
        setAttachments((prev) => {
          const existing = new Set(prev.map((a) => a.path));
          const unique = newAttachments.filter((a) => !existing.has(a.path));
          return [...prev, ...unique];
        });
        setText(
          (previous) =>
            `${previous}${previous && !previous.endsWith(" ") ? " " : ""}${newAttachments.map((file) => `@./${file.path}`).join(" ")} `,
        );
      } catch (error) {
        const key = error instanceof Error ? error.message : "chatComposer.uploadFailed";
        toast.error(t(key));
      }
    }

    // 清空 input 以便重复选择
    fileInputRef.current.value = "";
  }, [fileWorkspaceId, t]);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const removeQuote = useCallback(
    (id: string) => {
      removeContext(id, contextScope);
      setQuotes((current) => current.filter((quote) => quote.id !== id));
    },
    [contextScope],
  );

  const handleCommandSelect = useCallback((command: AvailableCommand) => {
    setText(`/${command.name} `);
    setShowCommandMenu(false);
    setCommandFilter("");
    textareaRef.current?.focus();
  }, []);

  const handleFilePickerSelect = useCallback((file: FileInfo) => {
    setText((prev) => prev.replace(/@$/, ""));
    setText((prev) => `${prev}@./${file.path} `);
    setAttachments((prev) => {
      if (prev.some((a) => a.path === file.path)) return prev;
      return [...prev, { name: file.name, path: file.path }];
    });
    setShowFilePicker(false);
    textareaRef.current?.focus();
  }, []);

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
    envId: fileWorkspaceId ?? "",
    onUploaded: handleFilePickerSelect,
    onError: (message) => toast.error(message),
    disabled,
  });

  // ---------------------------------------------------------------------------
  // canSend 计算 — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------
  const canSend = (text.trim() || images.length > 0 || attachments.length > 0 || quotes.length > 0) && !disabled;

  const handleNewSession = useCallback(() => {
    for (const quote of quotes) removeContext(quote.id, contextScope);
    setText("");
    setImages([]);
    setAttachments([]);
    setQuotes([]);
    onNewSession?.();
  }, [contextScope, onNewSession, quotes]);

  // ---------------------------------------------------------------------------
  // Render — 玻璃磨砂容器 + 大 textarea + 底部脚标行
  // ---------------------------------------------------------------------------
  return (
    <div
      className={cn(
        // chat-composer-wrapper：作为窄屏容器（如 MetaAgentPanel）收紧外边距的 CSS 作用域钩子
        "chat-composer-wrapper w-full max-w-3xl mx-auto px-4 sm:px-8 pb-4 pt-2",
        className,
      )}
    >
      {/* relative wrapper：CommandMenu 在此层定位，不受 .chat-composer-card 的 overflow: clip 裁剪 */}
      <div className="relative">
        {/* Slash command menu —— 浮在 composer-card 上方，不被 overflow 裁剪 */}
        {showCommandMenu && commands && commands.length > 0 && (
          <CommandMenu
            commands={commands}
            filter={commandFilter}
            onSelect={handleCommandSelect}
            onClose={() => {
              setShowCommandMenu(false);
              setCommandFilter("");
            }}
            className="absolute bottom-full left-0 right-0 mb-1 z-50"
          />
        )}

        <div
          className={cn("chat-composer-card", isDragOver && "bg-brand/5 shadow-[inset_0_0_0_2px_var(--color-brand)]")}
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
            setAttachments((prev) => {
              if (prev.some((a) => a.path === cleanPath)) return prev;
              return [...prev, { name, path: cleanPath }];
            });
            textareaRef.current?.focus();
          }}
        >
          {/* File Picker Dialog */}
          {showFilePicker && fileWorkspaceId && (
            <FilePickerDialog
              open={showFilePicker}
              envId={fileWorkspaceId}
              onClose={() => setShowFilePicker(false)}
              onSelect={handleFilePickerSelect}
            />
          )}

          <ComposerAssets
            images={images}
            files={attachments}
            quotes={quotes}
            onRemoveImage={removeImage}
            onRemoveFile={(path) => setAttachments((current) => current.filter((file) => file.path !== path))}
            onRemoveQuote={removeQuote}
          />

          <div className="px-4 pt-4 pb-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={_placeholder}
              disabled={disabled}
              rows={1}
              className="chat-composer-textarea w-full resize-none border-none bg-transparent outline-none text-sm text-text-primary placeholder:text-text-muted min-h-[58px] max-h-[200px] leading-relaxed"
            />
          </div>

          <ComposerToolbar
            commands={commands}
            disabled={disabled}
            isLoading={isLoading}
            canCancel={canCancel}
            isCancelling={isCancelling}
            canSend={Boolean(canSend)}
            supportsAttachments={supportsImages || Boolean(fileWorkspaceId)}
            fileInputRef={fileInputRef}
            onFileSelect={() => void _handleFileSelect()}
            onCommandSelect={handleCommandSelect}
            contextUsage={contextUsage}
            availableModes={availableModes}
            currentModeId={currentModeId}
            onModeChange={onModeChange}
            modelName={modelName}
            showNewSession={showNewSession}
            onNewSession={handleNewSession}
            onSubmit={handleSubmit}
            onInterrupt={onInterrupt}
          />
        </div>

        {/* 上传进度提示 */}
        {isUploading && (
          <div className="text-center">
            <span className="text-[11px] text-text-muted">
              {t("chatComposer.uploadingFiles", { count: uploadingCount })}
            </span>
          </div>
        )}

        {/* 提示文本 */}
        <div className="text-center mt-1.5">
          <span className="text-[11px] text-text-muted">{t("chatComposer.hint")}</span>
        </div>
      </div>
    </div>
  );
}
