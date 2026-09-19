import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../lib/i18n";
import {
  limitQuotedText,
  MAX_QUOTE_COUNT,
  MAX_TOTAL_QUOTED_TEXT_LENGTH,
  serializeChatQuotes,
} from "../lib/context-queue";
import type { AvailableCommand, ChatInputMessage, UserMessageImage } from "../types";
import type { McpOption } from "./CommandMenu";
import { type ComposerExternalSubscribe, useComposerExternalInput } from "./composer-effects";
import {
  type ComposerFileInfo,
  type CompressImage,
  processImageFiles,
  type UploadComposerFiles,
  uploadComposerFiles,
} from "./composer-file-processing";
import type { ComposerState } from "./composer-state";
import { removeSlashCommand } from "./internal/remove-slash-command";

/**
 * 输入岛事件处理器。
 *
 * 来源：从 `packages/agent-runtime/web/components/chat/ChatComposer.tsx` 的 handlers 段切出
 * （拆分原因是源文件 597 行超过 500 行红线）。处理器逻辑、分支顺序与注释逐字保留，
 * 只把「直接调宿主 api/toast」替换为注入回调。
 * 纯化改动点：sonner toast → `onNotice`；`@/src/api/fs` → `uploadFiles`；
 * `browser-image-compression` → `compressImage`；3 个 window 事件 → `subscribeExternal`。
 */

/** 用户可见提示（纯化替代 sonner toast）：`info` 为配额类提示，`error` 为失败提示。 */
export interface ComposerNotice {
  level: "info" | "error";
  message: string;
}

/** 提示出口（纯化替代 sonner toast）。 */
export type ComposerNoticeHandler = (notice: ComposerNotice) => void;

export interface UseComposerHandlersOptions {
  /** `useComposerState` 的返回值（输入岛全部输入状态）。 */
  state: ComposerState;
  commands?: readonly AvailableCommand[];
  mcps: readonly McpOption[];
  disabled: boolean;
  isLoading: boolean;
  supportsImages: boolean;
  /** 宿主上传回调；缺省时普通附件选择与拖拽上传整体禁用。 */
  uploadFiles?: UploadComposerFiles;
  /** 宿主图片压缩回调；缺省时不压缩。 */
  compressImage?: CompressImage;
  /** 是否提供 `@` 文件引用入口（源实现以 envId 是否存在判定）。 */
  fileReferenceEnabled: boolean;
  onSubmit: (message: ChatInputMessage) => void;
  onNewSession?: () => void;
  onNotice?: ComposerNoticeHandler;
  /** 外部输入订阅（源实现为 3 个 window 事件监听）。 */
  subscribeExternal?: ComposerExternalSubscribe;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
}

/** `useComposerHandlers` 的返回值：ChatComposer 渲染层用到的全部事件处理器与文件选择器开关。 */
export interface ComposerHandlers {
  /** `@` 触发或外部注入打开的文件选择器开关。 */
  showFilePicker: boolean;
  /** 关闭文件选择器（宿主渲染的对话框 onClose 用）。 */
  closeFilePicker: () => void;
  handleSubmit: () => void;
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  handleInput: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  handlePaste: (e: ClipboardEvent) => void;
  /** 文件输入框的 change 处理器（图片走 base64，其他文件走上传）。 */
  handleFileSelect: () => Promise<void>;
  handleCommandSelect: (command: AvailableCommand) => void;
  handleFilePickerSelect: (file: ComposerFileInfo) => void;
  removeQuote: (id: string) => void;
  handleNewSession: () => void;
}

/** 输入岛的全部事件处理器（含外部输入订阅与 `@` 触发的文件选择器开关）。 */
export function useComposerHandlers({
  state,
  commands,
  mcps,
  disabled,
  isLoading,
  supportsImages,
  uploadFiles,
  compressImage,
  fileReferenceEnabled,
  onSubmit,
  onNewSession,
  onNotice,
  subscribeExternal,
  textareaRef,
  fileInputRef,
}: UseComposerHandlersOptions): ComposerHandlers {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const {
    text,
    setText,
    images,
    addImages,
    attachments,
    addAttachments,
    quotes,
    updateQuotes,
    selectedMcpIds,
    selectedCommandNames,
    commandPanelOpen,
    commandPanelSearch,
    commandFilter,
    filterCommandPanel,
    resetCommandFilter,
    closeCommandPanel,
    resetInput,
  } = state;

  const [showFilePicker, setShowFilePicker] = useState(false);
  const quoteSequenceRef = useRef(0);

  /** 提示出口（纯化替代 sonner toast）。 */
  const notify = useCallback(
    (level: ComposerNotice["level"], message: string) => {
      onNotice?.({ level, message });
    },
    [onNotice],
  );

  /**
   * 上传失败文案：本包校验抛出的 `chatComposer.*` i18n key 走翻译；
   * 宿主上传回调抛出的业务错误只回通用失败文案，原文进控制台保留诊断上下文。
   */
  const resolveUploadErrorMessage = useCallback(
    (error: unknown): string => {
      const key = error instanceof Error ? error.message : "";
      if (key.startsWith("chatComposer.")) return t(`chat.components.${key}`);
      console.warn("[ChatComposer] 文件上传失败:", error);
      return t("chat.components.chatComposer.uploadFailed");
    },
    [t],
  );

  // ---------------------------------------------------------------------------
  // 外部输入 — 替代源的 3 个 window 事件监听
  // ---------------------------------------------------------------------------

  /** 聊天引用：配额判断 + 截断（源实现逐字迁移）。 */
  const handleQuote = useCallback(
    (incoming: { text: string }) => {
      const quoteText = incoming.text;
      if (!quoteText.trim()) return;
      if (quotes.length >= MAX_QUOTE_COUNT) {
        notify("info", t("chat.components.composerAssets.quoteLimitReached"));
        return;
      }
      const quotedCharacterCount = quotes.reduce((total, quote) => total + Array.from(quote.text).length, 0);
      const remainingCharacterCount = MAX_TOTAL_QUOTED_TEXT_LENGTH - quotedCharacterCount;
      if (remainingCharacterCount <= 0) {
        notify("info", t("chat.components.composerAssets.quoteLimitReached"));
        return;
      }
      const { text: quotedText, omittedCharacterCount } = limitQuotedText(quoteText, remainingCharacterCount);
      if (!quotedText) return;
      quoteSequenceRef.current += 1;
      const id = `chat-quote-${Date.now()}-${quoteSequenceRef.current}`;
      updateQuotes((current) => [...current, { id, text: quotedText, omittedCharacterCount }]);
      if (omittedCharacterCount > 0) {
        notify("info", t("chat.components.composerAssets.quoteTruncated", { count: omittedCharacterCount }));
      }
      textareaRef.current?.focus();
    },
    [notify, quotes, t, textareaRef, updateQuotes],
  );

  useComposerExternalInput(subscribeExternal, {
    onSuggestedPrompt: (prompt) => {
      if (prompt) setText(prompt);
    },
    onFileReference: (file) => {
      setText((prev) => `${prev}@./${file.path} `);
      addAttachments([{ name: file.name, path: file.path }]);
      textareaRef.current?.focus();
    },
    onQuote: handleQuote,
  });

  // ---------------------------------------------------------------------------
  // Handlers — 从 ChatInput 原样迁移
  // ---------------------------------------------------------------------------

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0 && attachments.length === 0 && quotes.length === 0) || disabled) return;

    const quoteContext = serializeChatQuotes(quotes);

    onSubmit({
      text: trimmed,
      images: images.length > 0 ? images : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      quoteContext,
      mcps:
        selectedMcpIds.size > 0 ? mcps.filter((mcp) => selectedMcpIds.has(mcp.id)).map((mcp) => mcp.name) : undefined,
    });
    resetInput();
    closeCommandPanel();
    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [
    text,
    images,
    attachments,
    quotes,
    selectedMcpIds,
    mcps,
    disabled,
    onSubmit,
    resetInput,
    closeCommandPanel,
    textareaRef,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (commandPanelOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          closeCommandPanel();
          return;
        }
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter") {
          e.preventDefault();
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
    [closeCommandPanel, commandPanelOpen, handleSubmit, isLoading],
  );

  const handleInput = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setText(value);

      // Slash command 仅在输入开头、且仍处于命令名阶段时打开同一个能力面板。
      if (value.startsWith("/") && commands?.length) {
        const commandText = value.slice(1);
        if (!/\s/.test(commandText)) {
          filterCommandPanel(commandText);
        } else {
          closeCommandPanel();
        }
      } else if (commandFilter || commandPanelOpen) {
        closeCommandPanel();
      }

      // 检测 @ 文件引用触发
      if (fileReferenceEnabled && value.endsWith("@")) {
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
    [closeCommandPanel, commandFilter, commandPanelOpen, commands, fileReferenceEnabled, filterCommandPanel, setText],
  );

  // 粘贴图片
  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      if (!supportsImages) return;
      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;

      e.preventDefault();
      const newImages: UserMessageImage[] = await processImageFiles(files, compressImage);
      addImages(newImages);
    },
    [addImages, compressImage, supportsImages],
  );

  // 选择文件（图片走 base64，其他文件上传到 workspace 根目录）
  const handleFileSelect = useCallback(async () => {
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
      const newImages = await processImageFiles(imageFiles, compressImage);
      addImages(newImages);
    }

    // 非图片：上传到 workspace 的 user/ 目录并添加为附件引用。
    if (otherFiles.length > 0 && uploadFiles) {
      try {
        const newAttachments = await uploadComposerFiles(otherFiles, uploadFiles);
        addAttachments(newAttachments);
        setText(
          (previous) =>
            `${previous}${previous && !previous.endsWith(" ") ? " " : ""}${newAttachments.map((file) => `@./${file.path}`).join(" ")} `,
        );
      } catch (error) {
        notify("error", resolveUploadErrorMessage(error));
      }
    }

    // 清空 input 以便重复选择
    fileInputRef.current.value = "";
  }, [addAttachments, addImages, compressImage, fileInputRef, notify, resolveUploadErrorMessage, setText, uploadFiles]);

  const removeQuote = useCallback(
    (id: string) => {
      updateQuotes((current) => current.filter((quote) => quote.id !== id));
    },
    [updateQuotes],
  );

  const handleCommandSelect = useCallback(
    (command: AvailableCommand) => {
      if (!commandPanelSearch) {
        setText(`/${command.name} `);
        closeCommandPanel();
        textareaRef.current?.focus();
        return;
      }
      setText((current) => {
        if (selectedCommandNames.has(command.name)) return removeSlashCommand(current, command.name);
        const separator = current.length > 0 && !current.endsWith(" ") ? " " : "";
        return `${current}${separator}/${command.name} `;
      });
      resetCommandFilter();
      textareaRef.current?.focus();
    },
    [closeCommandPanel, commandPanelSearch, resetCommandFilter, selectedCommandNames, setText, textareaRef],
  );

  const handleFilePickerSelect = useCallback(
    (file: ComposerFileInfo) => {
      setText((prev) => prev.replace(/@$/, ""));
      setText((prev) => `${prev}@./${file.path} `);
      addAttachments([{ name: file.name, path: file.path }]);
      setShowFilePicker(false);
      textareaRef.current?.focus();
    },
    [addAttachments, setText, textareaRef],
  );

  const handleNewSession = useCallback(() => {
    resetInput();
    onNewSession?.();
  }, [onNewSession, resetInput]);

  const closeFilePicker = useCallback(() => {
    setShowFilePicker(false);
  }, []);

  return {
    showFilePicker,
    closeFilePicker,
    handleSubmit,
    handleKeyDown,
    handleInput,
    handlePaste,
    handleFileSelect,
    handleCommandSelect,
    handleFilePickerSelect,
    removeQuote,
    handleNewSession,
  };
}
