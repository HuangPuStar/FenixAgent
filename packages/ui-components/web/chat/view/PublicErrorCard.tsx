import type { TFunction } from "i18next";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { type PublicErrorTextSource, publicErrorText } from "./public-error-text";

export interface PublicErrorCardProps {
  /** 后端脱敏投影的错误：`type` 决定本地化正文，`message` 是未登记 type 的兜底，`id` 是诊断标识。 */
  error: PublicErrorTextSource & { id: string };
  /** 容器附加类：调用方给外边距等上下文间距，组件本身不带外边距。 */
  className?: string;
  /** 顶部临时提示可手动关闭，且五秒后自动隐藏；历史消息默认保留。 */
  dismissible?: boolean;
  /** 临时提示关闭或超时后，通知持有者释放对应 Error ID 的展示记录。 */
  onDismiss?: (errorId: string) => void;
  /**
   * 调用方注入的取词函数。标题键 `chat.components.messageBubble.turnError` 归本包命名空间，
   * 但绑定哪本字典由调用方决定（宿主消费方 `ChatPanel` 读的是 `NS.UI_COMPONENTS`，
   * 与 `publicErrorText(t, error)` 既有的「`t` 由外部传入」约定一致）。
   */
  t: TFunction;
}

/**
 * 会话内的「本轮失败」错误卡片：标题 + 本地化正文 + `Type` / `ID` 尾注。
 *
 * 背景（2026-09-22 前端去重）：这张卡片在本仓有两份逐字实现——本包 `MessageBubble` 里渲染
 * 单条消息的 turn 失败，宿主 `apps/web/src/pages/agent-panel/ChatPanel.tsx` 里渲染整轮的
 * 分类错误；同样的 class、同样的 `role="alert"`、同样的 `chat.components.messageBubble.turnError`
 * 键、同样的 `publicErrorText` 与尾注，宿主那一份的注释里也自述「同一张卡片」。漂移已经发生
 * （宿主标题用 `<p>`、包内用 `<span>`；尾注字号一处显式 `text-xs` 一处继承）。
 *
 * 正文一律由 `type` 决定（`publicErrorText`），不读 `error.message`：后者是 wire/日志字段且恒为
 * 英文，直接上屏会让中文界面永远显示英文。
 */
export function PublicErrorCard({ error, className, t, dismissible = false, onDismiss }: PublicErrorCardProps) {
  const [dismissedErrorId, setDismissedErrorId] = useState<string | null>(null);
  const dismissed = dismissedErrorId === error.id;
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const dismiss = useCallback(() => {
    setDismissedErrorId(error.id);
    onDismissRef.current?.(error.id);
  }, [error.id]);
  useEffect(() => {
    if (!dismissible || dismissed) return;
    const timer = setTimeout(dismiss, 5_000);
    return () => clearTimeout(timer);
  }, [dismissible, dismissed, dismiss]);

  if (dismissible && dismissed) return null;
  return (
    <div
      className={cn(
        "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive",
        className,
      )}
      role="alert"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{t("chat.components.messageBubble.turnError")}</p>
        {dismissible && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            aria-label={t("chat.components.messageBubble.dismissError")}
            onClick={dismiss}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>
      <p className="mt-1 whitespace-pre-wrap">{publicErrorText(t, error)}</p>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="break-all">Type: {error.type}</span>
        <span className="break-all">ID: {error.id}</span>
      </div>
    </div>
  );
}
