import { ChevronDown, Copy, File, Quote } from "lucide-react";
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../src/i18n";
import { dispatchArtifactsPreviewFile, isWorkspaceRelativeFilePath } from "../../src/lib/artifacts-preview-events";
import { CardEventEmitter, MessageEmitterContext } from "../../src/lib/card-renderer";
import { isVisibleContentBlock } from "../../src/lib/context-queue";
import { splitSystemReminderBlocks } from "../../src/lib/strip-html-tags";
import type { AssistantMessageEntry, UserMessageEntry, UserMessageImage } from "../../src/lib/types";
import { MessageResponse } from "../ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../ai-elements/reasoning";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { SystemMessage } from "./SystemMessage";

// 用户消息折叠最大高度（px）
const COLLAPSED_MAX_HEIGHT = 200;
// 思考内容流式显示的最大高度（≈4 行）
const THOUGHT_STREAMING_MAX_HEIGHT = 96;
const FILE_REFERENCE_PATTERN = /@\.\/[^\s]+/g;

/** 将权威消息正文中的既有文件引用拆成文本和附件展示片段，不改变消息协议。 */
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
}

export function UserBubble({ entry, envId }: UserBubbleProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  // 切分注入的系统上下文段与用户文本段：system 段合并为原始块文本，渲染为
  // 系统消息标签默认隐藏注入内容；双击后以 Popover 展示。
  const segments = useMemo(() => splitSystemReminderBlocks(entry.content ?? ""), [entry.content]);
  // 原始块文本（含标签），双击系统消息标签后以 Popover 展示完整注入上下文
  const systemRawText = useMemo(
    () =>
      segments
        .filter((segment) => segment.kind === "system")
        .map((segment) => segment.text)
        .join("\n"),
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
      {/* 用户文本与图片附件 — 右对齐气泡（正文） */}
      {visibleContent && (
        <div className="flex justify-end">
          <div className="chat-user-message-frame">
            {/* 图片附件 */}
            {entry.images && entry.images.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2 justify-center">
                {entry.images.map((img) => (
                  <ImageThumbnail key={img.data} image={img} />
                ))}
              </div>
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
                      aria-label={t("fileTree.openFile", { name: part.value.split("/").at(-1) || part.value })}
                      data-file-attachment={part.value}
                      disabled={!envId || !isWorkspaceRelativeFilePath(part.value)}
                      onClick={() => {
                        if (envId && isWorkspaceRelativeFilePath(part.value)) {
                          dispatchArtifactsPreviewFile(envId, part.value);
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
                    <span>{t("messageBubble.expand")}</span>
                    <ChevronDown className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* 注入的系统上下文 — 居中“系统消息”标签，双击后以 Popover 展示原始块 */}
      {systemRawText && <SystemMessage rawText={systemRawText} />}
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
  /** 外部监听器通过此 ref 获取 emitter 实例进行订阅 */
  cardEmitterRef?: MutableRefObject<CardEventEmitter | null>;
}

export function AssistantBubble({ entry, isStreaming, sessionId, envId, cardEmitterRef }: AssistantBubbleProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  // 每个助手消息创建独立的 emitter 实例
  const emitter = useMemo(() => new CardEventEmitter(), []);
  const visibleText = useMemo(
    () =>
      entry.chunks
        .filter((chunk) => chunk.type === "message" && isVisibleContentBlock({ type: "text", text: chunk.text }))
        .map((chunk) => chunk.text)
        .join("\n\n")
        .trim(),
    [entry.chunks],
  );

  // 暴露 emitter 给外部监听器，组件卸载时清理
  useEffect(() => {
    if (cardEmitterRef) {
      cardEmitterRef.current = emitter;
    }
    return () => {
      if (cardEmitterRef) {
        cardEmitterRef.current = null;
      }
      emitter.destroy();
    };
  }, [emitter, cardEmitterRef]);

  return (
    <MessageEmitterContext.Provider value={emitter}>
      <div className="chat-assistant-message message-bubble-enter">
        {/* 内容 — 无卡片背景，直接排版；system-reminder 块渲染为系统消息而非隐藏 */}
        <div className="chat-assistant-chunks flex-1 min-w-0">
          {entry.chunks.map((chunk, i, all) => {
            if (chunk.type === "thought") {
              // 只有最后一个 thought chunk 且全局 streaming 时才标记为 streaming
              const isLastThought = i === all.length - 1 || all.slice(i + 1).every((c) => c.type !== "thought");
              const thoughtStreaming = isStreaming && isLastThought;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: chunks lack a unique identifier
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
                // biome-ignore lint/suspicious/noArrayIndexKey: chunks lack a unique identifier
                <SystemMessage key={i} rawText={chunk.text} />
              );
            }
            // 普通消息块 — 直接输出，无包裹卡片
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: chunks lack a unique identifier
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
              <span className="font-medium">{t("messageBubble.turnError")}</span>
              {entry.error.message && <p className="mt-1 whitespace-pre-wrap">{entry.error.message}</p>}
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span>Type: {entry.error.type}</span>
                <span>ID: {entry.error.id}</span>
              </div>
            </div>
          )}
        </div>
        {visibleText && (
          <div className="chat-message-actions" role="group" aria-label={t("messageBubble.actions")}>
            <button
              type="button"
              title={t("messageBubble.copy")}
              aria-label={t("messageBubble.copy")}
              onClick={() => void navigator.clipboard.writeText(visibleText)}
            >
              <Copy />
            </button>
            <button
              type="button"
              title={t("messageBubble.quote")}
              aria-label={t("messageBubble.quote")}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("chat:quote", { detail: { text: visibleText, contextScope: sessionId } }),
                )
              }
            >
              <Quote />
            </button>
          </div>
        )}
      </div>
    </MessageEmitterContext.Provider>
  );
}

// =============================================================================
// 图片缩略图 — 点击放大
// =============================================================================

function ImageThumbnail({ image }: { image: UserMessageImage }) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [open, setOpen] = useState(false);
  const dataUrl = `data:${image.mimeType};base64,${image.data}`;
  return (
    <>
      <Button variant="ghost" className="rounded-lg overflow-hidden p-0 h-auto" onClick={() => setOpen(true)}>
        <img src={dataUrl} alt={t("messageBubble.uploadedImage")} className="h-20 w-20 object-cover" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[min(92vw,960px)] p-3 bg-white">
          <DialogTitle className="sr-only">{t("messageBubble.imagePreview")}</DialogTitle>
          <img src={dataUrl} alt={t("messageBubble.uploadedImage")} className="max-h-[82vh] w-full object-contain" />
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: text 变化时滚动到底部
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
