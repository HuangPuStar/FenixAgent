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
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import {
  limitQuotedText,
  MAX_QUOTE_COUNT,
  MAX_TOTAL_QUOTED_TEXT_LENGTH,
  serializeChatQuotes,
} from "../lib/context-queue";
import type { AvailableCommand, ChatInputMessage, FileAttachment, UserMessageImage } from "../types";
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
 * 来源：从 `packages/agent-runtime/web/components/chat/ChatComposer.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除） 的 handlers 段切出
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

/**
 * 读取剪贴板里的图片文件（粘贴图片的入口，两个来源都要看）。
 *
 * 为什么要回退到 `items`：`clipboardData.files` 并非所有来源都填充——从网页「复制图片」、
 * 从 Office 文档或某些截图工具粘贴时，图片只出现在 `clipboardData.items`（kind === "file"）；
 * 只看 `files` 会让这类粘贴落到「没有文件 → 直接 return」，即用户看到的「粘贴没反应」。
 * 用下标遍历 `items` 而非迭代器：与包内 `primitives/internal/prompt-input-textarea.tsx` 同一写法，
 * 不依赖 `lib.dom.iterable` 的 `DataTransferItemList[Symbol.iterator]`。
 *
 * 只收 `image/*`：非图片内容（纯文本、HTML、普通文件）必须留给浏览器默认粘贴行为，
 * 由调用方保证不 `preventDefault`。
 */
function readPastedImageFiles(clipboard: DataTransfer): File[] {
  const fromFiles: File[] = [];
  const files = clipboard.files;
  for (let index = 0; index < (files?.length ?? 0); index += 1) {
    const file = files[index];
    if (file?.type.startsWith("image/")) fromFiles.push(file);
  }
  if (fromFiles.length > 0) return fromFiles;

  const fromItems: File[] = [];
  const items = clipboard.items;
  for (let index = 0; index < (items?.length ?? 0); index += 1) {
    const item = items[index];
    if (item?.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems;
}

// ---------------------------------------------------------------------------
// 粘贴图片的文件命名：可读日期时间戳 + 页内递增序号 + 短随机后缀
//
// 为什么必须自带唯一性（2026-09-24 用户反馈「图片粘贴要有日期时间戳保证不覆盖」）：
// 服务端上传对同名文件是**静默覆盖**——`LocalBackend.upload` 逐个 `fs.writeFile(destPath, content)`
// （`packages/resources/machine/src/server/services/file-backends.ts:299`，`writeFile` 缺省 flag `w`），
// 上传链路里没有存在性检查、也没有自动改名（实测同一目录同名上传两次：第二次不报错、返回同一个
// `user/image.png`，磁盘内容被替换、目录里仍只有一个文件）。而粘贴来的截图默认都叫 `image.png`，
// 于是「同一张图粘两次」「同一批粘两张截图」会互相顶掉；又因为附件按 `path` 去重
// （`composer-state.ts` 的 `addAttachments`），用户看到的是「第二张没进来/第一张被换成第二张」。
//
// 命名三段各自解决什么：
// - `yyyyMMdd-HHmmss`（本地时间，可读可排序）——用户要在 workspace、文件树与 `@./user/<name>` 里
//   认出这是什么时候粘的；旧实现用裸 `Date.now()` 毫秒，既不可读也没有区分度（同一次 `map` 里
//   所有图片拿到同一个毫秒值）。
// - 页内递增序号——对「同一秒内连续粘贴 / 同一批多张 / 重复粘贴同一张图」给**确定性**保证：
//   每次调用必自增，因此同一页面内生成的名字不可能重复（不依赖时钟分辨率）。
// - 6 位 base36 随机后缀——序号只保证同一页内唯一，跨页面/跨标签页（序号从头开始）靠它避开
//   与既有文件撞名；时间戳本身也已与历史粘贴拉开。
//
// 边界：客户端只能构造唯一名，无法探测 workspace 里是否已存在同名文件（composer 没有列目录端口，
// 上传响应也不回传「是否覆盖」），因此「同秒 + 同序号 + 同随机」这一理论上仍可能的重合无法识别；
// 该残差登记在报告里，需要强保证时应给上传加条件写（服务端 `ifMatch` 语义）。
// ---------------------------------------------------------------------------

/** 可读的本地时间戳 `yyyyMMdd-HHmmss`（粘贴图片名的时间部分）。 */
export function formatPastedImageStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${datePart}-${timePart}`;
}

/** 页内递增序号（模块级，跨多次粘贴累加；重置时机 = 页面重新加载）。 */
let pastedImageSequence = 0;

/** 6 位 base36 随机后缀；`padEnd` 兜住 `Math.random()` 尾部 0 被裁短的情况。 */
function createRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

/** 保留图片扩展名：优先原文件名的扩展名（用户可辨识），否则按 MIME 子类型，取不到退回 `png`。 */
function pastedImageExtension(file: File): string {
  const dotIndex = file.name.lastIndexOf(".");
  const fromName =
    dotIndex > 0
      ? file.name
          .slice(dotIndex + 1)
          .replace(/[^a-z0-9]/gi, "")
          .toLowerCase()
      : "";
  if (fromName) return fromName;
  const fromType = file.type
    .slice(file.type.indexOf("/") + 1)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  return fromType || "png";
}

/**
 * 生成粘贴图片的落盘名：`pasted-image-<yyyyMMdd>-<HHmmss>-<序号>-<随机>.<ext>`。
 *
 * `now` 可注入：测试据此断言时间戳格式而不依赖真实时钟。
 */
export function createPastedImageName(file: File, now: Date = new Date()): string {
  pastedImageSequence += 1;
  return `pasted-image-${formatPastedImageStamp(now)}-${pastedImageSequence}-${createRandomSuffix()}.${pastedImageExtension(file)}`;
}

/**
 * 把粘贴的图片换成带时间戳的唯一名（上传通路专用；内联 base64 通路不使用文件名）。
 *
 * 一律改名而不是「只在没有名字时补名」：有名字的剪贴板图片（`image.png`、从文件管理器复制的
 * 同名截图）同样会互相覆盖，只补无名的那种挡不住最主要的覆盖场景。
 */
function withPastedImageName(file: File): File {
  return new File([file], createPastedImageName(file), { type: file.type });
}

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
  /**
   * 正在转换成资产的粘贴图片数量（内联编码与上传两条通路都计入）。
   *
   * 粘贴到资产出现之间有一段无反馈窗口（压缩大图、上传大文件），用户会以为「粘贴没反应」
   * 而重复粘贴；渲染层据此显示进行中状态。拖拽上传有自己的计数（`useDragUpload`），两者各自独立。
   */
  pastingImageCount: number;
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
    readQuotes,
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
  // 粘贴图片的进行中计数（见 `ComposerHandlers.pastingImageCount`）
  const [pastingImageCount, setPastingImageCount] = useState(0);
  const quoteSequenceRef = useRef(0);

  /** 提示出口（纯化替代 sonner toast）。 */
  const notify = useCallback(
    (level: ComposerNotice["level"], message: string) => {
      onNotice?.({ level, message });
    },
    [onNotice],
  );

  /**
   * 图片准备的部分失败回执：`processImageFiles` 对处理失败的单张图片只留 `console.error`
   * 并把该张从结果里剔除；调用方不比对数量的话，失败的图片会静默消失
   * （粘贴 3 张成功 2 张时，用户以为已全部进入待发送区）。
   */
  const notifySkippedImages = useCallback(
    (requested: number, produced: number) => {
      if (produced < requested) {
        notify("error", t("chat.components.composerAssets.processImagePartialFailed"));
      }
    },
    [notify, t],
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
      // 配额读同步 ref 而非渲染期 `quotes`：同一批次内连续派发多条引用时，渲染期变量尚未更新，
      // 每条都按旧额度放行即可绕过 8 条 / 8000 字符上限（源实现用 `quotesRef.current`）。
      const currentQuotes = readQuotes();
      if (currentQuotes.length >= MAX_QUOTE_COUNT) {
        notify("info", t("chat.components.composerAssets.quoteLimitReached"));
        return;
      }
      const quotedCharacterCount = currentQuotes.reduce((total, quote) => total + Array.from(quote.text).length, 0);
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
    [notify, readQuotes, t, textareaRef, updateQuotes],
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

  /**
   * 把附件落成 `@./<workspace 相对路径>` 引用追加进正文。
   *
   * 这是本项目附件入口的统一约定（文件选择、拖拽上传、粘贴上传都走它）：附件清单本身经
   * `addAttachments` 进入待发送资产行，正文里的引用让 agent 能直接读到文件；发送边界
   * （`use-chat-input-submit`）对正文里已存在的引用不会重复追加。
   */
  const appendAttachmentMentions = useCallback(
    (files: FileAttachment[]) => {
      if (files.length === 0) return;
      setText(
        (previous) =>
          `${previous}${previous && !previous.endsWith(" ") ? " " : ""}${files.map((file) => `@./${file.path}`).join(" ")} `,
      );
    },
    [setText],
  );

  /**
   * 粘贴图片 → 待发送资产。
   *
   * 两条通路的选择（顺序即优先级）：
   * 1. agent 声明可收 ACP 图片内容块（`supportsImages`）→ 旧行为：压缩后编码为内联 base64 图片，
   *    模型直接看到像素；
   * 2. 否则复用宿主注入的 `uploadFiles`——与拖拽上传、文件选择**同一条** workspace 上传通路
   *    （`uploadComposerFiles` 的体积校验 + `{name, path}` 映射），图片落成文件资产。
   *
   * 为什么必须要有第 2 条：`supportsImages` 来自 Yjs 能力投影，而该投影把 agent 的嵌套
   * `promptCapabilities` 折成了布尔（`chat-writer` 的 `Boolean(value)`），宿主按嵌套结构读永远
   * 拿不到 `image === true`。旧实现在此直接 `return`，粘贴图片于真实界面「什么都没发生」——
   * 而同一张图拖进来却能上传成功，两个入口行为不一致。
   *
   * 边界：只接管图片；纯文本/HTML/普通文件的粘贴一律不 `preventDefault`，保持浏览器默认行为。
   * 两条通路都不可用时给明确回执，同样不 `preventDefault`（剪贴板可能还带文本，不能被吞掉）。
   */
  const handlePaste = useCallback(
    async (e: ClipboardEvent) => {
      const files = readPastedImageFiles(e.clipboardData);
      if (files.length === 0) return;

      if (supportsImages) {
        e.preventDefault();
        setPastingImageCount(files.length);
        try {
          const newImages: UserMessageImage[] = await processImageFiles(files, compressImage);
          notifySkippedImages(files.length, newImages.length);
          addImages(newImages);
        } finally {
          setPastingImageCount(0);
        }
        return;
      }

      if (uploadFiles) {
        e.preventDefault();
        setPastingImageCount(files.length);
        try {
          // 体积校验跑在**原始**剪贴板文件上（改名只发生在这层适配器里，名字不该影响体积判定）；
          // 上传端口拿到的是带时间戳的唯一名副本——服务端对同名静默覆盖，见 `withPastedImageName`。
          const newAttachments = await uploadComposerFiles(files, (batch) =>
            uploadFiles(batch.map((file) => withPastedImageName(file))),
          );
          addAttachments(newAttachments);
          appendAttachmentMentions(newAttachments);
        } catch (error) {
          notify("error", resolveUploadErrorMessage(error));
        } finally {
          setPastingImageCount(0);
        }
        return;
      }

      // 两条通路都不可用（宿主既没注入上传端口、agent 也不支持图片内容块）：给可见回执，不静默丢弃
      // ——旧实现在这里什么也不做，用户看到的就是「粘贴没反应」。
      notify("error", t("chat.components.composerAssets.pasteImageUnsupported"));
    },
    [
      addAttachments,
      addImages,
      appendAttachmentMentions,
      compressImage,
      notify,
      notifySkippedImages,
      resolveUploadErrorMessage,
      supportsImages,
      t,
      uploadFiles,
    ],
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
      notifySkippedImages(imageFiles.length, newImages.length);
      addImages(newImages);
    }

    // 非图片：上传到 workspace 的 user/ 目录并添加为附件引用。
    if (otherFiles.length > 0 && uploadFiles) {
      try {
        const newAttachments = await uploadComposerFiles(otherFiles, uploadFiles);
        addAttachments(newAttachments);
        appendAttachmentMentions(newAttachments);
      } catch (error) {
        notify("error", resolveUploadErrorMessage(error));
      }
    }

    // 清空 input 以便重复选择
    fileInputRef.current.value = "";
  }, [
    addAttachments,
    addImages,
    appendAttachmentMentions,
    compressImage,
    fileInputRef,
    notify,
    notifySkippedImages,
    resolveUploadErrorMessage,
    uploadFiles,
  ]);

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
    pastingImageCount,
    handleFileSelect,
    handleCommandSelect,
    handleFilePickerSelect,
    removeQuote,
    handleNewSession,
  };
}
