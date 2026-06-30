import imageCompression from "browser-image-compression";
import { Send, Square } from "lucide-react";
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ACPClient } from "../../src/acp/client";
import type { AvailableCommand, SessionMode } from "../../src/acp/types";
import { fileApi } from "../../src/api/files";
import { FilePickerDialog } from "../../src/components/FilePickerDialog";
import type { TokenStats } from "../../src/lib/token-stats";
import type { ChatInputMessage, FileAttachment, UserMessageImage } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import type { FileInfo } from "../../src/types";
import { ModelSelectorPopover } from "../model-selector/ModelSelectorPopover";
import { Button } from "../ui/button";
import { CommandMenu } from "./CommandMenu";
import { SessionModeSelector } from "./SessionModeSelector";

// 图片压缩配置
const IMAGE_COMPRESSION_OPTIONS = {
  maxSizeMB: 2,
  maxWidthOrHeight: 2048,
  useWebWorker: true,
  fileType: "image/jpeg" as const,
};

// 元信息条 token 统计所用的上下文窗口假设上限，用于进度条和百分比归一化
const MAX_CONTEXT_TOKENS = 200000;

/** ChatComposer 属性 — 新玻璃磨砂命令岛输入组件 */
interface ChatComposerProps {
  onSubmit: (message: ChatInputMessage) => void;
  isLoading?: boolean;
  onInterrupt?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** 是否支持图片上传 */
  supportsImages?: boolean;
  /** Agent 提供的可用 slash 命令 */
  commands?: AvailableCommand[];
  /** 环境 ID，用于文件上传/浏览（workspace 按环境隔离） */
  envId?: string;
  /** ACP 客户端实例，用于获取 Agent 能力。
   *  Task 3 骨架阶段未使用；Task 5 接入 ModelSelectorPopover 时才会真正调用 client。 */
  client?: ACPClient;
  /** 可用会话模式列表（Task 5 元信息条用到） */
  availableModes?: SessionMode[];
  /** 当前会话模式 ID（Task 5 元信息条用到） */
  currentModeId?: string | null;
  /** 模式切换回调（Task 5 元信息条用到） */
  onModeChange?: (modeId: string) => void;
  /** Token 统计信息（Task 5 元信息条用到） */
  tokenStats?: TokenStats;
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
 * SessionModeSelector / ModelSelectorPopover / token 统计 / 新会话 / 发送。
 */
export function ChatComposer({
  onSubmit,
  isLoading = false,
  onInterrupt,
  disabled = false,
  placeholder,
  supportsImages = false,
  commands,
  envId,
  client,
  availableModes,
  currentModeId,
  onModeChange,
  tokenStats,
  onNewSession,
  showNewSession,
  className,
}: ChatComposerProps) {
  const { t } = useTranslation("components");
  const _placeholder = placeholder ?? t("chatInput.placeholder");

  // ---------------------------------------------------------------------------
  // State — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------
  const [text, setText] = useState("");
  const [images, setImages] = useState<UserMessageImage[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);

  // ---------------------------------------------------------------------------
  // Refs — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 文件上传和浏览使用 envId（environment ID），后端路由为 /web/environments/:envId/user/*
  const fileWorkspaceId = envId;

  // ---------------------------------------------------------------------------
  // Effects — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------

  // 监听文件树引用事件（右键菜单"引用到聊天"）
  useEffect(() => {
    const handler = (e: Event) => {
      const { path, name } = (e as CustomEvent).detail;
      setText((prev) => `${prev}@./${path} `);
      setAttachments((prev) => {
        if (prev.some((a) => a.path === path)) return prev;
        return [...prev, { name, path }];
      });
      textareaRef.current?.focus();
    };
    window.addEventListener("file-tree:reference", handler);
    return () => window.removeEventListener("file-tree:reference", handler);
  }, []);

  // ---------------------------------------------------------------------------
  // Handlers — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------

  // 拖拽文件路径到输入框（从文件树拖拽）
  const handleDrop = useCallback((e: DragEvent) => {
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
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || disabled) return;

    onSubmit({
      text: trimmed,
      images: images.length > 0 ? images : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setText("");
    setImages([]);
    setAttachments([]);
    setShowCommandMenu(false);
    setCommandFilter("");
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, images, attachments, disabled, onSubmit]);

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

  // 选择文件（图片走 base64，其他文件上传到 user/ 文件夹）
  const _handleFileSelect = useCallback(async () => {
    if (!fileInputRef.current || !fileWorkspaceId) return;
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

    // 非图片：上传到 user/ 文件夹并添加为附件引用
    if (otherFiles.length > 0) {
      try {
        const formData = new FormData();
        for (const file of otherFiles) {
          formData.append("files", file);
        }
        await fileApi.upload(fileWorkspaceId, formData);
        const newAttachments: FileAttachment[] = otherFiles.map((f) => ({
          name: f.name,
          path: `user/${f.name}`,
        }));
        setAttachments((prev) => {
          const existing = new Set(prev.map((a) => a.path));
          const unique = newAttachments.filter((a) => !existing.has(a.path));
          return [...prev, ...unique];
        });
      } catch (err) {
        console.error("Failed to upload files:", err);
      }
    }

    // 清空 input 以便重复选择
    fileInputRef.current.value = "";
  }, [fileWorkspaceId]);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

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

  const _toggleCommandMenu = useCallback(() => {
    if (showCommandMenu) {
      setShowCommandMenu(false);
      setCommandFilter("");
    } else {
      if (!text.startsWith("/")) {
        setText(`/${text}`);
      }
      setShowCommandMenu(true);
      setCommandFilter(text.startsWith("/") ? text.slice(1).split(/\s/)[0] || "" : "");
      textareaRef.current?.focus();
    }
  }, [showCommandMenu, text]);

  // ---------------------------------------------------------------------------
  // canSend 计算 — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------
  const canSend = (text.trim() || images.length > 0) && !disabled;

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

        <div className="chat-composer-card" onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
          {/* File Picker Dialog */}
          {showFilePicker && fileWorkspaceId && (
            <FilePickerDialog
              open={showFilePicker}
              envId={fileWorkspaceId}
              onClose={() => setShowFilePicker(false)}
              onSelect={handleFilePickerSelect}
            />
          )}

          {/* 图片预览 */}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {images.map((img, i) => (
                <div key={img.data} className="relative group">
                  <img
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={`Attached image ${i + 1}`}
                    className="h-14 w-14 object-cover rounded-lg border border-border"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 min-h-[32px] min-w-[32px] rounded-full bg-surface-2 border border-border text-text-muted hover:text-text-primary text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={`Remove image ${i + 1}`}
                  >
                    {"\u00D7"}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* 编辑区 —— textarea + 发送按钮，按钮在右下 */}
          <div className="flex items-end gap-2 px-4 pt-4 pb-2">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={_placeholder}
              disabled={disabled}
              rows={1}
              className="chat-composer-textarea flex-1 resize-none border-none bg-transparent outline-none text-sm text-text-primary placeholder:text-text-muted min-h-[48px] max-h-[200px] leading-relaxed"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={isLoading ? onInterrupt : handleSubmit}
              disabled={!isLoading && !canSend}
              className={cn(
                "h-9 w-9 shrink-0 p-0 rounded-lg flex items-center justify-center",
                isLoading
                  ? "bg-text-primary text-surface-2 hover:bg-text-secondary"
                  : canSend
                    ? "bg-brand text-white hover:bg-brand-light"
                    : "bg-surface-3 text-text-muted",
              )}
            >
              {isLoading ? <Square className="h-3.5 w-3.5" fill="currentColor" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>

          {/* 底部元信息条 —— flex-wrap 允许数据多时换行到第二行 */}
          <div className="chat-composer-meta flex flex-wrap items-center gap-2.5 px-4 py-2.5 text-[11px]">
            {/* 左侧：模式 + 模型 */}
            {availableModes && availableModes.length > 0 && onModeChange && (
              <SessionModeSelector
                modes={availableModes}
                currentModeId={currentModeId ?? null}
                onModeChange={onModeChange}
              />
            )}

            {client && <ModelSelectorPopover client={client} />}

            {/* 中间弹簧 */}
            <div className="flex-1" />

            {/* 右侧：token 进度条 + 百分比 + 新会话 */}
            {tokenStats && tokenStats.estimatedTokens > 0 && (
              // chat-composer-token-stats：包裹 token 进度条/百分比/分隔线，作为窄屏容器隐藏的 CSS 作用域钩子。
              // 使用 contents 让该 wrapper 不参与 flex 布局，子元素照常作为 meta 条的直接 flex item
              <div className="chat-composer-token-stats contents">
                <div className="w-12 h-1 rounded-full bg-surface-3 overflow-hidden flex shrink-0">
                  <div
                    className="h-full bg-brand transition-[width] duration-500"
                    style={{
                      width: `${Math.min((tokenStats.estimatedInputTokens / MAX_CONTEXT_TOKENS) * 100, 100)}%`,
                    }}
                  />
                  <div
                    className="h-full bg-accent-green transition-[width] duration-500"
                    style={{
                      width: `${Math.min((tokenStats.estimatedOutputTokens / MAX_CONTEXT_TOKENS) * 100, 100)}%`,
                    }}
                  />
                </div>
                <span className="font-mono text-text-primary font-semibold min-w-[28px] text-right">
                  {Math.min(Math.round((tokenStats.estimatedTokens / MAX_CONTEXT_TOKENS) * 100), 100)}%
                </span>
                <span className="chat-composer-divider" />
              </div>
            )}

            {showNewSession && onNewSession && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onNewSession}
                className="h-7 px-2 text-[11px] text-text-muted hover:text-text-primary gap-1"
              >
                + {t("chatComposer.newSession")}
              </Button>
            )}
          </div>
        </div>

        {/* 提示文本 */}
        <div className="text-center mt-1.5">
          <span className="text-[11px] text-text-muted">{t("chatComposer.hint")}</span>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// 图片处理工具 — 从 ChatInput 原样迁移
// =============================================================================

async function processImageFiles(files: File[]): Promise<UserMessageImage[]> {
  const results: UserMessageImage[] = [];

  for (const file of files) {
    try {
      let blob: Blob = file;
      let mimeType = file.type;

      if (file.size > 2 * 1024 * 1024) {
        const compressed = await imageCompression(file, IMAGE_COMPRESSION_OPTIONS);
        blob = compressed;
        mimeType = "image/jpeg";
      }

      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          const commaIdx = result.indexOf(",");
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        };
        reader.onerror = () => reject(new Error("FileReader error"));
        reader.readAsDataURL(blob);
      });

      results.push({ mimeType, data: base64 });
    } catch (err) {
      console.error("Failed to process image:", err);
    }
  }

  return results;
}
