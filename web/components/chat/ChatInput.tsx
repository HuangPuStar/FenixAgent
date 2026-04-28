import { useState, useRef, useCallback, type KeyboardEvent, type ClipboardEvent } from "react";
import { cn } from "../../src/lib/utils";
import { Button } from "../ui/button";
import { Send, Square, Paperclip, Slash, AtSign } from "lucide-react";
import type { ChatInputMessage, UserMessageImage, FileAttachment } from "../../src/lib/types";
import type { AvailableCommand } from "../../src/acp/types";
import type { FileInfo } from "../../src/types";
import { CommandMenu } from "./CommandMenu";
import { FilePickerDialog } from "../../src/components/FilePickerDialog";
import imageCompression from "browser-image-compression";

// 图片压缩配置
const IMAGE_COMPRESSION_OPTIONS = {
  maxSizeMB: 2,
  maxWidthOrHeight: 2048,
  useWebWorker: true,
  fileType: "image/jpeg" as const,
};

// =============================================================================
// Anthropic 风格聊天输入框 — 底部居中浮动卡片，橙色焦点环
// =============================================================================

interface ChatInputProps {
  onSubmit: (message: ChatInputMessage) => void;
  isLoading?: boolean;
  onInterrupt?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** 是否支持图片上传 */
  supportsImages?: boolean;
  /** Agent 提供的可用 slash 命令 */
  commands?: AvailableCommand[];
  /** 当前会话 ID，用于触发 @ 文件选择 */
  sessionId?: string;
  className?: string;
}

export function ChatInput({
  onSubmit,
  isLoading = false,
  onInterrupt,
  disabled = false,
  placeholder = "给智能体发送消息…",
  supportsImages = false,
  commands,
  sessionId,
  className,
}: ChatInputProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<UserMessageImage[]>([]);
  const [showCommandMenu, setShowCommandMenu] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || disabled) return;

    onSubmit({ text: trimmed, images: images.length > 0 ? images : undefined, attachments: attachments.length > 0 ? attachments : undefined });
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
          onInterrupt?.();
        } else {
          handleSubmit();
        }
      }
    },
    [handleSubmit, isLoading, onInterrupt, showCommandMenu],
  );

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);

    // 检测 slash 命令模式：仅在输入开头输入 / 时触发
    if (value.startsWith("/") && commands && commands.length > 0) {
      setShowCommandMenu(true);
      setCommandFilter(value.slice(1).split(/\s/)[0] || "");
    } else if (showCommandMenu) {
      setShowCommandMenu(false);
      setCommandFilter("");
    }

    // 检测 @ 文件引用触发
    if (sessionId && value.endsWith("@")) {
      const prevChar = value.length > 1 ? value[value.length - 2] : " ";
      if (prevChar === " " || value.length === 1) {
        setShowFilePicker(true);
      }
    }

    // 自动调整高度
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [commands, showCommandMenu]);

  // 粘贴图片
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    if (!supportsImages) return;
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;

    e.preventDefault();
    const newImages = await processImageFiles(files);
    setImages((prev) => [...prev, ...newImages]);
  }, [supportsImages]);

  // 选择文件
  const handleFileSelect = useCallback(async () => {
    if (!fileInputRef.current) return;
    const files = fileInputRef.current.files;
    if (!files || files.length === 0) return;

    const newImages = await processImageFiles(Array.from(files));
    setImages((prev) => [...prev, ...newImages]);
    // 清空 input 以便重复选择
    fileInputRef.current.value = "";
  }, []);

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
    setText((prev) => prev + `@${file.name} `);
    setAttachments((prev) => {
      if (prev.some((a) => a.path === file.path)) return prev;
      return [...prev, { name: file.name, path: file.path }];
    });
    setShowFilePicker(false);
    textareaRef.current?.focus();
  }, []);

  const toggleCommandMenu = useCallback(() => {
    if (showCommandMenu) {
      setShowCommandMenu(false);
      setCommandFilter("");
    } else {
      if (!text.startsWith("/")) {
        setText("/" + text);
      }
      setShowCommandMenu(true);
      setCommandFilter(text.startsWith("/") ? text.slice(1).split(/\s/)[0] || "" : "");
      textareaRef.current?.focus();
    }
  }, [showCommandMenu, text]);

  const canSend = (text.trim() || images.length > 0) && !disabled;

  return (
    <div className={cn("w-full max-w-3xl mx-auto px-4 sm:px-8 pb-4 pt-2", className)}>
      <div className="relative">
        {/* File Picker Dialog */}
        {showFilePicker && sessionId && (
          <FilePickerDialog
            open={showFilePicker}
            sessionId={sessionId}
            onClose={() => setShowFilePicker(false)}
            onSelect={handleFilePickerSelect}
          />
        )}

        {/* Slash command menu — floating above input */}
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
      <div className={cn(
        "rounded-xl border border-border bg-surface-2 overflow-hidden",
        "focus-within:border-brand/50 focus-within:shadow-[0_0_0_3px_rgba(217,119,87,0.15)] transition-all",
      )}>
        {/* 图片预览 */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((img, i) => (
              <div key={i} className="relative group">
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

        {/* 文件附件预览 */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2">
            {attachments.map((att, i) => (
              <div key={i} className="flex items-center gap-1.5 rounded-md bg-brand/10 px-2.5 py-1 text-xs text-brand">
                <span className="truncate max-w-[120px]">{att.name}</span>
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  className="text-text-muted hover:text-text-primary"
                >
                  {"\u00D7"}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 输入区域 — Anthropic 单行紧凑布局 */}
        <div className="flex items-end gap-2 px-3 py-2.5">
          {/* 左侧附件按钮 */}
          {supportsImages && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                className="flex-shrink-0 h-8 w-8 text-text-muted hover:text-text-secondary hover:bg-surface-1/50"
                disabled={disabled}
              >
                <Paperclip className="h-4 w-4" />
                <span className="sr-only">Attach file</span>
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
            </>
          )}

          {/* Slash 命令按钮 */}
          {commands && commands.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={toggleCommandMenu}
              className={cn(
                "flex-shrink-0 h-8 w-8",
                showCommandMenu
                  ? "bg-brand/15 text-brand"
                  : "text-text-muted hover:text-text-secondary hover:bg-surface-1/50",
              )}
              disabled={disabled}
              title="命令列表"
            >
              <Slash className="h-4 w-4" />
            </Button>
          )}

          {/* @ 文件引用按钮 */}
          {sessionId && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setShowFilePicker(true)}
              className="flex-shrink-0 h-8 w-8 text-text-muted hover:text-text-secondary hover:bg-surface-1/50"
              disabled={disabled}
              title="引用文件"
            >
              <AtSign className="h-4 w-4" />
            </Button>
          )}

          {/* Textarea — Poppins font */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={cn(
              "flex-1 resize-none border-none bg-transparent outline-none",
              "text-sm text-text-primary placeholder:text-text-muted font-display",
              "max-h-[200px] min-h-[24px] leading-normal",
            )}
          />

          {/* 右侧发送/取消按钮 */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={isLoading ? onInterrupt : handleSubmit}
            disabled={!isLoading && !canSend}
            className={cn(
              "flex-shrink-0 h-8 w-8",
              isLoading
                ? "bg-text-primary text-surface-2 hover:bg-text-secondary"
                : canSend
                  ? "bg-brand text-white hover:bg-brand-light hover:scale-[1.05] active:scale-[0.97]"
                  : "bg-surface-1 text-text-muted",
            )}
          >
            {isLoading ? (
              <Square className="h-3.5 w-3.5" fill="currentColor" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
      </div>{/* end relative */}

      {/* 提示文本 */}
      <div className="text-center mt-1.5">
        <span className="text-[11px] text-text-muted font-display">
          Enter 发送，Shift+Enter 换行
        </span>
      </div>
    </div>
  );
}

// =============================================================================
// 图片处理工具
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
