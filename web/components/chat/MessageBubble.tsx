import { ChevronDown } from "lucide-react";
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CardEventEmitter, MessageEmitterContext } from "../../src/lib/card-renderer";
import { isVisibleContentBlock } from "../../src/lib/context-queue";
import { splitSystemReminderBlocks } from "../../src/lib/strip-html-tags";
import type { AssistantMessageEntry, UserMessageEntry, UserMessageImage } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import { MessageResponse } from "../ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../ai-elements/reasoning";
import { Button } from "../ui/button";
import { AgentAvatar } from "./AgentAvatar";
import { SystemMessage } from "./SystemMessage";

// 用户消息折叠最大高度（px）
const COLLAPSED_MAX_HEIGHT = 200;
// 思考内容流式显示的最大高度（≈4 行）
const THOUGHT_STREAMING_MAX_HEIGHT = 96;

// =============================================================================
// 用户消息 — 右对齐，品牌色淡底，可折叠；注入的 system-reminder 渲染为系统消息
// =============================================================================

interface UserBubbleProps {
  entry: UserMessageEntry;
}

export function UserBubble({ entry }: UserBubbleProps) {
  const { t } = useTranslation("components");
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
          <div className="max-w-[85%] sm:max-w-[70%]">
            {/* 图片附件 */}
            {entry.images && entry.images.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2 justify-end">
                {entry.images.map((img) => (
                  <ImageThumbnail key={img.data} image={img} />
                ))}
              </div>
            )}
            {/* 文本内容 — 品牌色淡底 + 折叠 */}
            <div className="relative bg-user-bubble border border-user-bubble-border rounded-2xl overflow-hidden message-bubble-enter">
              <div
                ref={contentRef}
                className={cn(
                  "px-5 py-3 text-sm text-white whitespace-pre-wrap font-display leading-relaxed",
                  !expanded && overflowing && `max-h-[${COLLAPSED_MAX_HEIGHT}px]`,
                )}
                style={!expanded && overflowing ? { maxHeight: `${COLLAPSED_MAX_HEIGHT}px` } : undefined}
              >
                {visibleContent}
              </div>
              {/* 折叠渐变遮罩 + 展开按钮 */}
              {!expanded && overflowing && (
                <div className="absolute bottom-0 inset-x-0 flex flex-col items-center pt-8 bg-gradient-to-t from-user-bubble via-user-bubble/80 to-transparent">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpanded(true)}
                    className="flex items-center gap-1 px-3 py-1 rounded-full text-xs font-display font-medium text-white/90 hover:bg-white/15 h-auto"
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

export function AssistantBubble({ entry, isStreaming, envId, cardEmitterRef }: AssistantBubbleProps) {
  // 每个助手消息创建独立的 emitter 实例
  const emitter = useMemo(() => new CardEventEmitter(), []);

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
      <div className="flex gap-4 items-start message-bubble-enter">
        {/* Agent avatar — 窄屏隐藏 */}
        <AgentAvatar className="hidden md:flex mt-0.5" />
        {/* 内容 — 无卡片背景，直接排版；system-reminder 块渲染为系统消息而非隐藏 */}
        <div className="flex-1 min-w-0 space-y-4">
          {entry.chunks.map((chunk, i, all) => {
            if (chunk.type === "thought") {
              // 只有最后一个 thought chunk 且全局 streaming 时才标记为 streaming
              const isLastThought = i === all.length - 1 || all.slice(i + 1).every((c) => c.type !== "thought");
              const thoughtStreaming = isStreaming && isLastThought;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: chunks lack a unique identifier
                <Reasoning key={i} isStreaming={thoughtStreaming}>
                  <ReasoningTrigger />
                  <ReasoningContent>
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
              <div key={i} className="message-content text-text-primary leading-[1.75]">
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
              <p className="font-medium">执行出错</p>
              <p className="mt-1 whitespace-pre-wrap">{entry.error.message}</p>
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
                <span className="break-all">Type: {entry.error.type}</span>
                <span className="break-all">ID: {entry.error.id}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </MessageEmitterContext.Provider>
  );
}

// =============================================================================
// 图片缩略图 — 点击放大
// =============================================================================

function ImageThumbnail({ image }: { image: UserMessageImage }) {
  const { t } = useTranslation("components");
  const dataUrl = `data:${image.mimeType};base64,${image.data}`;
  return (
    <Button
      variant="ghost"
      className="rounded-lg overflow-hidden border border-border hover:border-brand/40 p-0 h-auto"
      onClick={() => {
        const w = window.open("");
        if (w) {
          w.document.write(`<img src="${dataUrl}" style="max-width:100%;max-height:100%" />`);
        }
      }}
    >
      <img src={dataUrl} alt={t("messageBubble.uploadedImage")} className="h-20 w-20 object-cover" />
    </Button>
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
