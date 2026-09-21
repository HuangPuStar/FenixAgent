import { ChevronDown, Copy, File, Quote } from "lucide-react";
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../../ui/dialog";
import { isVisibleContentBlock, parseChatQuotes } from "../lib/context-queue";
import { splitSystemReminderBlocks } from "../lib/strip-html-tags";
import { MessageResponse } from "../primitives/message";
import { MessageAttachment, MessageAttachments } from "../primitives/message-attachments";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../primitives/reasoning";
import type { AssistantMessageEntry, UserMessageEntry, UserMessageImage } from "../types";
import { ChatQuoteMessage } from "./ChatQuoteMessage";
import { type CardEmitter, createCardEmitter } from "./internal/card-emitter";
import { publicErrorText } from "./public-error-text";
import { SystemMessage } from "./SystemMessage";

/**
 * 卡片事件通道契约的对外出口。
 *
 * 来源：宿主 `@/src/lib/card-renderer` 的 `CardEventEmitter` 方法签名。纯化改动点：只保留结构契约，
 * 不引入宿主的 Context / 事件总线；实现细节见 `./internal/card-emitter`。
 */
export type { CardEmitter } from "./internal/card-emitter";

// 用户消息折叠最大高度（px）
const COLLAPSED_MAX_HEIGHT = 200;
// 思考内容流式显示的最大高度（≈4 行）
const THOUGHT_STREAMING_MAX_HEIGHT = 96;
const FILE_REFERENCE_PATTERN = /@\.\/[^\s]+/g;

/**
 * 工作区相对路径判定。
 *
 * 复制自 `apps/web/src/lib/artifacts-preview-events.ts` 的 `isWorkspaceRelativeFilePath`（逐字）。
 * 纯化改动点：源函数与「预览事件派发」同文件，本包只保留其词法校验部分（无 `..`、无绝对路径、
 * 无控制字符、无空段），避免把宿主的自定义事件总线拖进包内依赖图。
 */
function isWorkspaceRelativeFilePath(path: string): boolean {
  if (
    !path ||
    path.startsWith("/") ||
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * 将权威消息正文中的既有文件引用拆成文本和附件展示片段，不改变消息协议。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/MessageBubble.tsx`；纯化改动点：无。
 */
export function splitFileReferences(content: string): Array<{ type: "text" | "file"; value: string; offset: number }> {
  const parts: Array<{ type: "text" | "file"; value: string; offset: number }> = [];
  let offset = 0;
  for (const match of content.matchAll(FILE_REFERENCE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > offset) parts.push({ type: "text", value: content.slice(offset, index), offset });
    parts.push({ type: "file", value: match[0].slice(3), offset: index });
    offset = index + match[0].length;
  }
  if (offset < content.length) parts.push({ type: "text", value: content.slice(offset), offset });
  return parts;
}

// =============================================================================
// 用户消息 — 右对齐，品牌色淡底，可折叠；注入的 system-reminder 渲染为系统消息
// =============================================================================

interface UserBubbleProps {
  entry: UserMessageEntry;
  envId?: string;
  /**
   * 点击正文中的工作区文件引用时回调，替代源实现的 `dispatchArtifactsPreviewFile` 事件派发；
   * 由宿主决定如何打开预览（宿主路由/面板）。
   */
  onOpenWorkspaceFile?: (envId: string, path: string) => void;
}

/**
 * 用户消息气泡（右对齐、可折叠、图片缩略图）。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/MessageBubble.tsx`。
 * 纯化改动点：
 * - 文件引用的打开动作由宿主事件总线改为 `onOpenWorkspaceFile` 回调 prop。
 * - i18n 命名空间收敛为包内单一命名空间并加 `chat.components.` 前缀。
 * - 类名、DOM 结构、折叠阈值与交互逐字保留。
 */
export function UserBubble({ entry, envId, onOpenWorkspaceFile }: UserBubbleProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  // 注入的 system-reminder 只供 Agent 消费，不属于用户可见的聊天历史。
  const segments = useMemo(() => splitSystemReminderBlocks(entry.content ?? ""), [entry.content]);
  const systemSegments = useMemo(
    () =>
      segments
        .filter((segment) => segment.kind === "system")
        .map((segment) => ({ segment, quotes: parseChatQuotes(segment.text) })),
    [segments],
  );
  const visibleContent = segments
    .filter((segment) => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n");
  const visibleParts = useMemo(() => splitFileReferences(visibleContent), [visibleContent]);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const checkOverflow = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    setOverflowing(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 4);
  }, []);

  useEffect(() => {
    checkOverflow();
  }, [checkOverflow]);

  return (
    <div className="flex flex-col gap-2">
      {systemSegments.map(({ segment, quotes: segmentQuotes }) =>
        segmentQuotes.length > 0 ? (
          <div key={segment.text} className="chat-quote-messages">
            {segmentQuotes.map((quote, quoteIndex) => (
              <ChatQuoteMessage key={`${quote.text}-${quote.omittedCharacterCount}`} quote={quote} index={quoteIndex} />
            ))}
          </div>
        ) : (
          <SystemMessage key={segment.text} rawText={segment.text} />
        ),
      )}
      {/* 用户文本与图片附件 — 右对齐气泡（正文） */}
      {visibleContent && (
        <div className="flex justify-end">
          <div className="chat-user-message-frame">
            {/* 图片附件 — 与消息附件共用同一套 attach 基元，横向排布、按需换行 */}
            {entry.images && entry.images.length > 0 && (
              <MessageAttachments className="mb-2">
                {entry.images.map((image) => (
                  <UserImageAttachment key={image.url ?? image.data} image={image} />
                ))}
              </MessageAttachments>
            )}
            {/* 文本内容 — 品牌色淡底 + 折叠 */}
            <div className="chat-user-bubble message-bubble-enter">
              <div
                ref={contentRef}
                className="chat-user-message-content px-4 py-2.5 text-sm font-display leading-relaxed"
                style={!expanded && overflowing ? { maxHeight: `${COLLAPSED_MAX_HEIGHT}px` } : undefined}
              >
                {visibleParts.map((part) =>
                  part.type === "file" ? (
                    <button
                      type="button"
                      key={`${part.type}-${part.offset}`}
                      className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-background/70 px-2 py-0.5 align-middle text-xs text-text-secondary hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:cursor-default disabled:opacity-70"
                      title={part.value}
                      aria-label={t("chat.components.fileTree.openFile", {
                        name: part.value.split("/").at(-1) || part.value,
                      })}
                      data-file-attachment={part.value}
                      disabled={!envId || !isWorkspaceRelativeFilePath(part.value)}
                      onClick={() => {
                        if (envId && isWorkspaceRelativeFilePath(part.value)) {
                          onOpenWorkspaceFile?.(envId, part.value);
                        }
                      }}
                    >
                      <File className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{part.value.split("/").at(-1) || part.value}</span>
                    </button>
                  ) : (
                    part.value
                  ),
                )}
              </div>
              {/* 折叠渐变遮罩 + 展开按钮 */}
              {!expanded && overflowing && (
                <div className="absolute bottom-0 inset-x-0 flex flex-col items-center pt-8 bg-gradient-to-t from-white via-white/90 to-transparent">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpanded(true)}
                    className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-display font-medium text-text-secondary hover:bg-surface-2 h-auto"
                  >
                    <span>{t("chat.components.messageBubble.expand")}</span>
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// 助手消息 — 左对齐，无背景卡片，编辑式排版
// =============================================================================

interface AssistantBubbleProps {
  entry: AssistantMessageEntry;
  isStreaming?: boolean;
  sessionId?: string;
  envId?: string;
  /**
   * 宿主注入的卡片事件通道；未注入时组件自建独立实例（保持源实现的消息级隔离）。
   * 替代源实现的宿主 `CardEventEmitter` + `MessageEmitterContext` 组合。
   */
  cardEmitter?: CardEmitter | null;
  /** 外部监听器通过此 ref 获取 emitter 实例进行订阅 */
  cardEmitterRef?: MutableRefObject<CardEmitter | null>;
  /** 点击「引用」时回调，替代源实现的 `chat:quote` window 自定义事件。 */
  onQuote?: (text: string, sessionId?: string) => void;
}

/**
 * 助手消息气泡（左对齐、思考块、系统提醒标签、复制/引用动作、turn 错误）。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/MessageBubble.tsx`。
 * 纯化改动点：
 * - 移除宿主 `MessageEmitterContext.Provider` 包裹：改由 `cardEmitter` prop 注入，未注入时自建实例，
 *   并通过 `cardEmitterRef` 供外部订阅（不再向子树下发 React Context，包内无该通道消费方）。
 * - `chat:quote` window 自定义事件改为 `onQuote` 回调 prop。
 * - `@/components/ai-elements/*`、`@/components/ui/*`、`@/src/lib/*` 全部收敛到包内相对路径。
 */
export function AssistantBubble({
  entry,
  isStreaming,
  sessionId,
  envId,
  cardEmitter,
  cardEmitterRef,
  onQuote,
}: AssistantBubbleProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  // 每个助手消息创建独立的 emitter 实例
  const internalEmitter = useMemo(() => (cardEmitter ? null : createCardEmitter()), [cardEmitter]);
  const emitter = cardEmitter ?? internalEmitter;
  const visibleText = useMemo(
    () =>
      entry.chunks
        .filter((chunk) => chunk.type === "message" && isVisibleContentBlock({ type: "text", text: chunk.text }))
        .map((chunk) => chunk.text)
        .join("\n\n")
        .trim(),
    [entry.chunks],
  );

  // 暴露 emitter 给外部监听器，组件卸载时清理；宿主注入的实例不归本组件销毁。
  useEffect(() => {
    if (cardEmitterRef) {
      cardEmitterRef.current = emitter;
    }
    return () => {
      if (cardEmitterRef) {
        cardEmitterRef.current = null;
      }
      internalEmitter?.destroy();
    };
  }, [emitter, internalEmitter, cardEmitterRef]);

  // turn 失败正文按稳定的 `error.type` 取本地化文案：`error.message` 是 wire/日志字段且恒为英文
  // （`isPublicError` 以它做帧完整性校验），直接渲染会让中文界面永远显示英文，见 `./public-error-text`。
  const errorText = useMemo(() => (entry.error ? publicErrorText(t, entry.error) : ""), [entry.error, t]);

  return (
    <div className="chat-assistant-message message-bubble-enter">
      {/* 内容 — 无卡片背景，直接排版；system-reminder 块渲染为系统消息而非隐藏 */}
      <div className="chat-assistant-chunks flex-1 min-w-0">
        {entry.chunks.map((chunk, i, all) => {
          if (chunk.type === "thought") {
            // 只有最后一个 thought chunk 且全局 streaming 时才标记为 streaming
            const isLastThought = i === all.length - 1 || all.slice(i + 1).every((c) => c.type !== "thought");
            const thoughtStreaming = isStreaming && isLastThought;
            return (
              // Chunks lack a unique identifier.
              // biome-ignore lint/suspicious/noArrayIndexKey: 协议块本身没有唯一 id（源文件同款写法）。本包 package.json 声明了 react 依赖，biome 因而启用 react 域规则；源宿主 packages/agent-runtime 未声明 react，规则未启用。chunks 只整体替换、不重排，索引键不会引起元素错位。
              <Reasoning key={i} isStreaming={thoughtStreaming} className="chat-thinking-block">
                <ReasoningTrigger className="chat-thinking-trigger" />
                <ReasoningContent className="chat-thinking-content">
                  <ThoughtContent text={chunk.text} isStreaming={thoughtStreaming} />
                </ReasoningContent>
              </Reasoning>
            );
          }
          // 完整 system-reminder 块 — 渲染为系统消息标签，双击后以 Popover 展示原始块
          if (!isVisibleContentBlock({ type: "text", text: chunk.text })) {
            return (
              // Chunks lack a unique identifier.
              // biome-ignore lint/suspicious/noArrayIndexKey: 同上前提——协议块无唯一 id，且本包启用了 react 域规则；chunks 不重排。
              <SystemMessage key={i} rawText={chunk.text} />
            );
          }
          // 普通消息块 — 直接输出，无包裹卡片
          return (
            // Chunks lack a unique identifier.
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上前提——协议块无唯一 id，且本包启用了 react 域规则；chunks 不重排。
            <div key={i} className="message-content chat-markdown-content text-text-primary leading-[1.75]">
              <MessageResponse envId={envId}>{chunk.text}</MessageResponse>
            </div>
          );
        })}
        {/* turn 失败错误（后端 ChatEntry.error 脱敏投影）— 展示在消息末尾 */}
        {entry.error && (
          <div
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            <span className="font-medium">{t("chat.components.messageBubble.turnError")}</span>
            {errorText && <p className="mt-1 whitespace-pre-wrap">{errorText}</p>}
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>Type: {entry.error.type}</span>
              <span>ID: {entry.error.id}</span>
            </div>
          </div>
        )}
      </div>
      {visibleText && (
        <div className="chat-message-actions" role="group" aria-label={t("chat.components.messageBubble.actions")}>
          <button
            type="button"
            title={t("chat.components.messageBubble.copy")}
            aria-label={t("chat.components.messageBubble.copy")}
            onClick={() => void navigator.clipboard.writeText(visibleText)}
          >
            <Copy />
          </button>
          <button
            type="button"
            title={t("chat.components.messageBubble.quote")}
            aria-label={t("chat.components.messageBubble.quote")}
            onClick={() => onQuote?.(visibleText, sessionId)}
          >
            <Quote />
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// 图片附件 — 复用消息附件基元，点击放大
// =============================================================================

/**
 * 用户消息中的图片缩略图（点击放大查看原图）。
 *
 * 纯化改动点（相对源 `ImageThumbnail`）：自绘的 `<img className="h-20 w-20">` 换成消息附件基元
 * `MessageAttachment`，与助手消息附件（`MessageAttachments`）保持同一套视觉；外层 `Button`
 * 保留源实现的点击放大与键盘可达性（未传 `onRemove`，基元内部不会出现嵌套按钮）。
 */
function UserImageAttachment({ image }: { image: UserMessageImage }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [open, setOpen] = useState(false);
  // 展示地址优先取 `url`，缺省时回退到 base64 载荷拼出的 data URL。
  const src = image.url ?? `data:${image.mimeType};base64,${image.data}`;
  const alt = t("chat.components.messageBubble.uploadedImage");
  return (
    <>
      <Button variant="ghost" className="h-auto rounded-lg p-0" onClick={() => setOpen(true)}>
        <MessageAttachment alt={alt} data={{ type: "file", mediaType: image.mimeType, url: src }} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(92vw,960px)] p-3 bg-white">
          <DialogTitle className="sr-only">{t("chat.components.messageBubble.imagePreview")}</DialogTitle>
          <img src={src} alt={alt} className="max-h-[82vh] w-full object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

// =============================================================================
// 思考内容 — streaming 时固定高度 + 自动滚底，非 streaming 时也是固定高度
// 始终使用同一容器，避免 isStreaming 切换时的高度跳变
// =============================================================================

function ThoughtContent({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  // text 变化时滚动到底部。
  // biome-ignore lint/correctness/useExhaustiveDependencies: text 不参与计算，只作为「内容增长」的触发信号，移除该依赖会丢失流式自动滚底（源文件同款写法，源宿主未启用 react 域规则）。
  useEffect(() => {
    if (!isStreaming) return;
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text, isStreaming]);

  return (
    <div
      ref={containerRef}
      className="text-sm text-text-secondary leading-relaxed overflow-y-auto"
      style={{ maxHeight: `${THOUGHT_STREAMING_MAX_HEIGHT}px` }}
    >
      {text}
    </div>
  );
}
