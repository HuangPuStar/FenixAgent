/**
 * 消息渲染元件（Message / MessageContent / MessageBranch / MessageResponse / MessageToolbar）。
 *
 * 已知限制（streamdown 表格全屏补丁未随包迁移）：源宿主在应用入口调用 `installStreamdownTablePatch()`
 * 为 streamdown 全屏表格对话框补上缺失的 `data-streamdown="table-wrapper"`，修复复制/下载按钮无响应；该补丁属于应用壳。
 *   影响范围：仅 streamdown 表格全屏视图内的复制/下载按钮；其余 markdown 渲染与消息流程不受影响。
 *   移除条件：streamdown 自身修复该 DOM 缺失，或宿主在入口安装等价补丁。
 *
 * 已知限制（envId 指向宿主文件代理路由）：`MessageResponse` 的 `envId` 会把相对资源路径改写为
 *   `/web/environments/<envId>/fs/<path>?preview=true`，该前缀是源宿主应用的文件代理约定，本包不定义该路由。
 *   影响范围：不传 `envId` 时 URL 原样透传，组件不依赖任何宿主路由；传 `envId` 的宿主必须自行提供该路由。
 *   移除条件：宿主改为注入自己的 urlTransform，或把代理前缀提升为 prop。
 */

import type { UIMessage } from "ai";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, ErrorInfo, HTMLAttributes, ReactElement, ReactNode } from "react";
import {
  Component,
  createContext,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { Components } from "streamdown";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { getRegisteredAllowedTags, getRegisteredComponents } from "../../lib/card-renderer";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { ButtonGroup, ButtonGroupText } from "../../ui/button-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../ui/tooltip";
import "./chat-message-content.css";
import { IframePreview } from "./iframe-preview";

export {
  MessageAttachment,
  type MessageAttachmentProps,
  MessageAttachments,
  type MessageAttachmentsProps,
} from "./message-attachments";

class StreamdownErrorBoundary extends Component<{ children: ReactElement; fallback?: string }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Streamdown failed to load:", error, info);
  }
  render() {
    if (this.state.hasError) {
      return <div className="chat-markdown-response whitespace-pre-wrap break-words">{this.props.fallback}</div>;
    }
    return this.props.children;
  }
}

const LazyStreamdown = lazy(() => import("streamdown").then((m) => ({ default: m.Streamdown })));

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[85%] min-w-0 flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "chat-message-content is-user:dark flex w-fit max-w-full flex-col gap-2 overflow-hidden text-sm break-words",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

type MessageBranchContextType = {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
};

const MessageBranchContext = createContext<MessageBranchContextType | null>(null);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error("MessageBranch components must be used within MessageBranch");
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({ defaultBranch = 0, onBranchChange, className, ...props }: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = (newBranch: number) => {
    setCurrentBranch(newBranch);
    onBranchChange?.(newBranch);
  };

  const goToPrevious = () => {
    const newBranch = currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  };

  const goToNext = () => {
    const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  };

  const contextValue: MessageBranchContextType = {
    currentBranch,
    totalBranches: branches.length,
    goToPrevious,
    goToNext,
    branches,
    setBranches,
  };

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div className={cn("grid w-full gap-2 [&>div]:pb-0", className)} {...props} />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({ children, ...props }: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = Array.isArray(children) ? children : [children];

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn("grid gap-2 overflow-hidden [&>div]:pb-0", index === currentBranch ? "block" : "hidden")}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const MessageBranchSelector = ({ className, from, ...props }: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className="[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md"
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({ children, ...props }: MessageBranchPreviousProps) => {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label={t("message.previousBranch")}
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({ children, className, ...props }: MessageBranchNextProps) => {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label={t("message.nextBranch")}
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({ className, ...props }: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn("border-none bg-transparent text-muted-foreground shadow-none", className)}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = {
  children?: string;
  className?: string;
  mode?: "static" | "streaming";
  sessionId?: string;
  /** environmentId，用于构建文件预览 URL */
  envId?: string;
};

export const MessageResponse = memo(
  ({ className, children, envId, ...props }: MessageResponseProps) => {
    const urlTransform = useCallback(
      (url: string) => {
        if (!envId) return url;
        // Rewrite relative workspace paths (./user/xxx, user/xxx, /user/xxx) to the host's file-proxy route.
        const match = url.match(/^(?:\.?\/)?(user\/.*)$/);
        if (match) {
          return `/web/environments/${envId}/fs/${match[1]}?preview=true`;
        }
        return url;
      },
      [envId],
    );

    // 合并注册表中已注册的标签白名单到 streamdown allowedTags。
    // 包内注册表默认为空 → 未显式注册的自定义标签不在白名单中，会被 rehype-sanitize 剥离（XSS 安全默认）。
    const allowedTags = useMemo(() => {
      const base: Record<string, string[]> = {
        iframe: ["src", "width", "height", "title", "sandbox", "loading"],
        video: ["src"],
        source: ["src"],
        track: ["src"],
        audio: ["src"],
      };
      const registered = getRegisteredAllowedTags();
      return { ...base, ...registered };
    }, []);

    // 合并注册表中已注册的组件到 streamdown components
    const components = useMemo((): Components => {
      const base = {
        img: ({ src, alt, ...rest }: Record<string, unknown>) => (
          <img
            src={src as string}
            alt={(alt as string) || ""}
            style={{ maxWidth: "100%", maxHeight: "50vh", objectFit: "contain" }}
            {...Object.fromEntries(Object.entries(rest).filter(([k]) => !["children", "node"].includes(k)))}
          />
        ),
        iframe: (props: Record<string, unknown>) => <IframePreview {...props} />,
        video: ({ src, children, className: _cx, ...rest }: Record<string, unknown>) => (
          <a
            href={src as string}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            {...Object.fromEntries(Object.entries(rest).filter(([k]) => !["children", "node"].includes(k)))}
          >
            {(children as ReactNode) || (src as string)}
          </a>
        ),
        audio: ({ src, children, className: _cx, ...rest }: Record<string, unknown>) => (
          <a
            href={src as string}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            {...Object.fromEntries(Object.entries(rest).filter(([k]) => !["children", "node"].includes(k)))}
          >
            {(children as ReactNode) || (src as string)}
          </a>
        ),
        a: ({ href, children, className: _cx, ...rest }: Record<string, unknown>) => {
          const hrefStr = typeof href === "string" ? href : "";
          const safeProps = Object.fromEntries(Object.entries(rest).filter(([k]) => !["children", "node"].includes(k)));
          return (
            <a
              href={hrefStr}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
              {...safeProps}
            >
              {children as ReactNode}
            </a>
          );
        },
      };
      const registered = getRegisteredComponents();
      return { ...base, ...registered } as Components;
    }, []);

    return (
      <StreamdownErrorBoundary fallback={children}>
        <Suspense
          fallback={
            <div className={cn("chat-markdown-response whitespace-pre-wrap break-words", className)}>{children}</div>
          }
        >
          <LazyStreamdown
            allowedTags={allowedTags}
            components={components}
            urlTransform={urlTransform}
            // `chat-markdown-content` 在源仓库由宿主容器（MessageBubble）提供，markdown 排版
            // （标题/列表/引用/代码块/表格，chat-message-content.css 内 32 条规则）全挂在它上面。
            // 包内自带该容器类，才能在宿主未提供时也渲染出正确排版；宿主已提供时重复声明同值，
            // 且该样式表未包 @layer，其 color/font-size 在两侧都压过 text-text-primary，故为无副作用。
            className={cn(
              "chat-markdown-content chat-markdown-response chat-markdown-response--rendered size-full break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
              className,
            )}
            {...props}
          >
            {children}
          </LazyStreamdown>
        </Suspense>
      </StreamdownErrorBoundary>
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children && prevProps.envId === nextProps.envId,
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn("mt-4 flex w-full items-center justify-between gap-4", className)} {...props}>
    {children}
  </div>
);
