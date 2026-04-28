import { useState, useRef, useEffect, useCallback } from "react";
import type { UserMessageEntry, AssistantMessageEntry, UserMessageImage } from "../../src/lib/types";
import { cn, esc } from "../../src/lib/utils";
import { MessageResponse } from "../ai-elements/message";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "../ai-elements/reasoning";
import { Button } from "../ui/button";
import { ChevronDown } from "lucide-react";

// 用户消息折叠最大高度（px）
const COLLAPSED_MAX_HEIGHT = 200;

// =============================================================================
// 用户消息 — 右对齐，品牌色淡底，可折叠
// =============================================================================

interface UserBubbleProps {
  entry: UserMessageEntry;
}

export function UserBubble({ entry }: UserBubbleProps) {
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
  }, [checkOverflow, entry.content]);

  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] sm:max-w-[70%]">
        {/* 图片附件 */}
        {entry.images && entry.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 justify-end">
            {entry.images.map((img, i) => (
              <ImageThumbnail key={i} image={img} />
            ))}
          </div>
        )}
        {/* 文本内容 — 品牌色淡底 + 折叠 */}
        {entry.content && (
          <div className="relative rounded-2xl rounded-br-md bg-user-bubble border border-user-bubble-border overflow-hidden">
            <div
              ref={contentRef}
              className={cn(
                "px-5 py-3 text-sm text-white whitespace-pre-wrap font-display leading-relaxed",
                !expanded && overflowing && `max-h-[${COLLAPSED_MAX_HEIGHT}px]`,
              )}
              style={!expanded && overflowing ? { maxHeight: `${COLLAPSED_MAX_HEIGHT}px` } : undefined}
            >
              {esc(entry.content)}
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
                  <span>展开</span>
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// 助手消息 — 左对齐，无背景卡片，编辑式排版
// =============================================================================

interface AssistantBubbleProps {
  entry: AssistantMessageEntry;
  isStreaming?: boolean;
}

export function AssistantBubble({ entry, isStreaming }: AssistantBubbleProps) {
  return (
    <div className="flex gap-4 items-start">
      {/* Agent avatar */}
      <div className="w-8 h-8 rounded-lg bg-brand/8 flex items-center justify-center flex-shrink-0 mt-0.5">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="6" r="2.5" fill="var(--color-brand)" />
          <circle cx="6" cy="16" r="2.5" fill="var(--color-brand)" opacity=".85" />
          <circle cx="18" cy="16" r="2.5" fill="var(--color-brand)" opacity=".85" />
          <circle cx="12" cy="12" r="1.5" fill="var(--color-brand)" opacity=".6" />
          <line x1="12" y1="8.5" x2="12" y2="10.5" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
          <line x1="12" y1="13.5" x2="7.2" y2="15.2" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
          <line x1="12" y1="13.5" x2="16.8" y2="15.2" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
          <line x1="8.2" y1="16" x2="15.8" y2="16" stroke="var(--color-brand)" strokeWidth="1" opacity=".3" />
        </svg>
      </div>
      {/* 内容 — 无卡片背景，直接排版 */}
      <div className="flex-1 min-w-0 space-y-4">
        {/* Sender label */}
        <span className="text-sm font-semibold text-text-primary font-display">智能体</span>
        {entry.chunks.map((chunk, i) => {
          if (chunk.type === "thought") {
            const isLastChunk = i === entry.chunks.length - 1;
            const isThoughtStreaming = isStreaming && isLastChunk;
            return (
              <Reasoning key={i} isStreaming={isThoughtStreaming}>
                <ReasoningTrigger />
                <ReasoningContent>
                  <div className="text-sm text-text-secondary leading-relaxed">
                    {chunk.text}
                  </div>
                </ReasoningContent>
              </Reasoning>
            );
          }
          // 普通消息块 — 直接输出，无包裹卡片
          return (
            <div key={i} className="message-content text-text-primary leading-[1.75]">
              <MessageResponse>{chunk.text}</MessageResponse>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// 图片缩略图 — 点击放大
// =============================================================================

function ImageThumbnail({ image }: { image: UserMessageImage }) {
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
      <img
        src={dataUrl}
        alt="Uploaded image"
        className="h-20 w-20 object-cover"
      />
    </Button>
  );
}
