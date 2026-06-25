"use client";

import type { FileUIPart, UIMessage } from "ai";
import { ChevronLeftIcon, ChevronRightIcon, Maximize2, Minimize2, PaperclipIcon, XIcon } from "lucide-react";
import type { ComponentProps, ErrorInfo, HTMLAttributes, ReactElement } from "react";
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
import { getRegisteredAllowedTags, getRegisteredComponents } from "../../src/lib/card-renderer";
import { cn } from "../../src/lib/utils";
import { Button } from "../ui/button";
import { ButtonGroup, ButtonGroupText } from "../ui/button-group";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

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
      return <div className="whitespace-pre-wrap break-words">{this.props.fallback}</div>;
    }
    return this.props.children;
  }
}

const LazyStreamdown = lazy(() => import("streamdown").then((m) => ({ default: m.Streamdown })));

const PREVIEW_SIZES = [
  { key: "sm", label: "小", w: "60vw", maxW: 800, h: "60vh", maxH: 600 },
  { key: "md", label: "中", w: "80vw", maxW: 1100, h: "75vh", maxH: 800 },
  { key: "lg", label: "大", w: "92vw", maxW: 1500, h: "88vh", maxH: 960 },
  { key: "full", label: "全屏", w: "98vw", maxW: 9999, h: "95vh", maxH: 9999 },
] as const;

function IframePreview({ src, width, height, title, ...rest }: Record<string, unknown>) {
  const { t } = useTranslation("components");
  const [expanded, setExpanded] = useState(false);
  const [sizeIdx, setSizeIdx] = useState(2); // 默认"大"
  const size = PREVIEW_SIZES[sizeIdx];
  return (
    <>
      <div className="relative group/iframe">
        <iframe
          src={src as string}
          width={(width as string) || "100%"}
          height={(height as string) || "400"}
          title={title as string}
          sandbox="allow-scripts allow-same-origin allow-popups"
          loading="lazy"
          style={{ border: "1px solid #e5e7eb", borderRadius: 8 }}
          {...Object.fromEntries(Object.entries(rest).filter(([k]) => !["children", "node"].includes(k)))}
        />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="absolute top-2 right-2 p-1.5 rounded-md bg-white/80 dark:bg-gray-800/80 opacity-0 group-hover/iframe:opacity-100 transition-opacity hover:bg-white dark:hover:bg-gray-700 shadow-sm"
          title={t("message.expand")}
        >
          <Maximize2 className="h-5 w-5 text-gray-600 dark:text-gray-300" />
        </button>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          showCloseButton={false}
          className="flex flex-col p-0 gap-0 overflow-hidden"
          style={{ width: size.w, maxWidth: size.maxW, height: size.h, maxHeight: size.maxH }}
        >
          <DialogHeader className="flex-row items-center justify-between px-3 py-2 border-b shrink-0 gap-2">
            <DialogTitle className="text-sm font-medium truncate">{(title as string) || "预览"}</DialogTitle>
            <div className="flex items-center gap-1 shrink-0">
              <div className="flex items-center rounded-md border border-border/60 overflow-hidden">
                {PREVIEW_SIZES.map((s, i) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => setSizeIdx(i)}
                    className={cn(
                      "px-2 py-0.5 text-xs transition-colors",
                      i === sizeIdx
                        ? "bg-brand text-white"
                        : "hover:bg-gray-100 dark:hover:bg-gray-700 text-text-secondary",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <DialogClose asChild>
                <button
                  type="button"
                  className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ml-1"
                  title={t("message.collapse")}
                >
                  <Minimize2 className="h-4 w-4" />
                </button>
              </DialogClose>
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            <iframe
              src={src as string}
              title={title as string}
              sandbox="allow-scripts allow-same-origin allow-popups"
              className="w-full h-full border-0"
              {...Object.fromEntries(Object.entries(rest).filter(([k]) => !["children", "node"].includes(k)))}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

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
      "is-user:dark flex w-fit max-w-full flex-col gap-2 overflow-hidden text-sm break-words",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    style={{ overflowWrap: "anywhere" }}
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
  const { t } = useTranslation("components");
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
  const { t } = useTranslation("components");
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
        // Rewrite relative paths like ./user/xxx, user/xxx, /user/xxx
        const match = url.match(/^(?:\.?\/)?(user\/.*)$/);
        if (match) {
          return `/web/environments/${envId}/${match[1]}?preview=true`;
        }
        return url;
      },
      [envId],
    );

    // 合并注册表中已注册的标签白名单到 streamdown allowedTags
    const allowedTags = useMemo(() => {
      const base: Record<string, string[]> = {
        iframe: ["src", "width", "height", "title", "sandbox", "loading"],
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
      };
      const registered = getRegisteredComponents();
      return { ...base, ...registered } as Components;
    }, []);

    return (
      <StreamdownErrorBoundary fallback={children}>
        <Suspense fallback={<div className={cn("whitespace-pre-wrap break-words", className)}>{children}</div>}>
          <LazyStreamdown
            allowedTags={allowedTags}
            components={components}
            urlTransform={urlTransform}
            className={cn(
              "size-full break-words [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
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

export type MessageAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart;
  className?: string;
  onRemove?: () => void;
};

export function MessageAttachment({ data, className, onRemove, ...props }: MessageAttachmentProps) {
  const { t } = useTranslation("components");
  const filename = data.filename || "";
  const mediaType = data.mediaType?.startsWith("image/") && data.url ? "image" : "file";
  const isImage = mediaType === "image";
  const attachmentLabel = filename || (isImage ? t("message.image") : t("message.attachment"));

  return (
    <div className={cn("group relative size-24 overflow-hidden rounded-lg", className)} {...props}>
      {isImage ? (
        <>
          <img
            alt={filename || t("message.attachment")}
            className="size-full object-cover"
            height={100}
            src={data.url}
            width={100}
          />
          {onRemove && (
            <Button
              aria-label={t("message.removeAttachment")}
              className="absolute top-2 right-2 size-6 rounded-full bg-background/80 p-0 opacity-0 backdrop-blur-sm transition-opacity hover:bg-background group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">{t("message.remove")}</span>
            </Button>
          )}
        </>
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex size-full shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <PaperclipIcon className="size-4" />
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>{attachmentLabel}</p>
            </TooltipContent>
          </Tooltip>
          {onRemove && (
            <Button
              aria-label={t("message.removeAttachment")}
              className="size-6 shrink-0 rounded-full p-0 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 [&>svg]:size-3"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">{t("message.remove")}</span>
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export type MessageAttachmentsProps = ComponentProps<"div">;

export function MessageAttachments({ children, className, ...props }: MessageAttachmentsProps) {
  if (!children) {
    return null;
  }

  return (
    <div className={cn("ml-auto flex w-fit flex-wrap items-start gap-2", className)} {...props}>
      {children}
    </div>
  );
}

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn("mt-4 flex w-full items-center justify-between gap-4", className)} {...props}>
    {children}
  </div>
);
