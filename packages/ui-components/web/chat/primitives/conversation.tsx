import { ArrowDownIcon, UserIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import "./conversation.css";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden overflow-x-hidden", className)}
    initial="instant"
    resize="instant"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn("mx-auto flex max-w-3xl flex-col gap-2 px-4 py-8 sm:px-8 sm:py-12 min-w-0", className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title,
  description,
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const _title = title ?? t("conversation.noMessages");
  const _description = description ?? t("conversation.startConversation");
  return (
    <div
      className={cn("flex size-full flex-col items-center justify-center gap-4 p-8 text-center", className)}
      {...props}
    >
      {children ?? (
        <>
          {icon && <div className="text-text-muted">{icon}</div>}
          <div className="space-y-2">
            <h3 className="font-semibold text-base font-display text-text-primary">{_title}</h3>
            {_description && <p className="text-text-muted text-sm leading-relaxed max-w-xs">{_description}</p>}
          </div>
        </>
      )}
    </div>
  );
};

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

/**
 * Button to scroll to the bottom of the conversation.
 * Can be used standalone or within ConversationScrollButtons container.
 * When used standalone, it handles its own visibility based on isAtBottom.
 * When used in ConversationScrollButtons, the container manages visibility.
 */
export const ConversationScrollButton = ({ className, ...props }: ConversationScrollButtonProps) => {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const { scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    <Button
      // 底色/阴影/backdrop、`padding-inline` 与 hover 配色在 `conversation.css`；
      // 该表未分层，因此其 `padding-inline: calc(var(--spacing) * 2.75)` 稳定压过 Button `size="sm"` 的
      // `has-[>svg]:px-2.5`（后者特指度 (0,1,1) 且同在 `@layer utilities`，搬成 `px-2.75` 会被压回 10px，
      // 故必须留在样式表）。高度/字号/基础色/悬停色四条扁平声明按刻度与色阶回到这里：`h-7.5` / `text-xs` /
      // `text-slate-600` / `hover:text-slate-700` 由 `cn()` 的后置位置经 tailwind-merge 消解 Button 的
      // `h-8` / `text-sm` / `hover:text-accent-foreground`，令牌层已把刻度按 px 落地（30px / 12px），
      // 与原先由未分层声明取胜的结果一致。
      className={cn(
        "chat-conversation-scroll-button w-auto h-7.5 text-xs text-slate-600 gap-1.5 rounded-full border-0 font-medium hover:bg-white hover:text-slate-700",
        className,
      )}
      onClick={handleScrollToBottom}
      size="sm"
      type="button"
      variant="outline"
      title={t("conversation.scrollToBottom")}
      {...props}
    >
      <ArrowDownIcon className="size-4" />
      <span>{t("conversation.scrollToBottom")}</span>
    </Button>
  );
};

/**
 * Data attribute used to mark the last user message element.
 * The host application adds this attribute to the last user message for scroll targeting.
 */
export const LAST_USER_MESSAGE_ATTR = "data-last-user-message";

export type ConversationScrollToLastUserMessageButtonProps = ComponentProps<typeof Button>;

/**
 * Button to scroll to the last user message in the conversation.
 * Reference: Issue #3 - Provide a feature to locate the last human message
 */
export const ConversationScrollToLastUserMessageButton = ({
  className,
  ...props
}: ConversationScrollToLastUserMessageButtonProps) => {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const handleScrollToLastUserMessage = useCallback(() => {
    // Find the last user message element by data attribute
    const lastUserMessage = document.querySelector(`[${LAST_USER_MESSAGE_ATTR}="true"]`);
    if (lastUserMessage) {
      lastUserMessage.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <Button
      className={cn("rounded-full", className)}
      onClick={handleScrollToLastUserMessage}
      size="icon"
      type="button"
      variant="outline"
      title={t("conversation.scrollToLastUserMessage")}
      {...props}
    >
      <UserIcon className="size-4" />
    </Button>
  );
};

export type ConversationScrollButtonsProps = ComponentProps<"div"> & {
  /** Whether there are user messages to scroll to */
  hasUserMessages?: boolean;
};

/**
 * Container for scroll navigation buttons.
 * Renders scroll-to-last-user-message and scroll-to-bottom buttons side by side.
 * Reference: Issue #3 - Provide a feature to locate the last human message
 */
export const ConversationScrollButtons = ({
  className,
  hasUserMessages = false,
  ...props
}: ConversationScrollButtonsProps) => {
  const { isAtBottom } = useStickToBottomContext();

  if (isAtBottom) return null;

  return (
    <div
      // 源实现那张 `conversation.css`（阶段三已迁空删除的历史表，与同目录同名伴随表无关）的
      // `.chat-scroll-navigation`：贴底居中，预留宿主浮动产物面板宽度。
      className={cn(
        "absolute bottom-3 left-[calc((100%-var(--chat-floating-artifacts-width,0px))/2)] z-[24] flex -translate-x-1/2",
        className,
      )}
      {...props}
    >
      <ConversationScrollButton />
    </div>
  );
};
