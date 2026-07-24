"use client";

import type { FileUIPart, UIMessage } from "ai";
import {
  AlertCircle,
  ChevronDown,
  ChevronLeftIcon,
  ChevronRightIcon,
  Clapperboard,
  Copy,
  Maximize as FullscreenIcon,
  Images,
  Maximize2,
  Minimize2,
  PaperclipIcon,
  Pause,
  Play,
  Volume2,
  VolumeX,
  XIcon,
} from "lucide-react";
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
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { Components } from "streamdown";
import { getRegisteredAllowedTags, getRegisteredComponents } from "../../src/lib/card-renderer";
import { cn } from "../../src/lib/utils";
import { CitationLink } from "../chat/CitationLink";
import { Button } from "../ui/button";
import { ButtonGroup, ButtonGroupText } from "../ui/button-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
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

/** 单个视频播放器：自绘现代控件，居中大播放按钮 + 底部毛玻璃进度条 */
export function VideoPlayerCard({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fileName = url.split("/").pop()?.split("?")[0] ?? url;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 兜底，忽略失败
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v?.duration) return;
    setProgress((v.currentTime / v.duration) * 100);
  };

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v) return;
    const rect = e.currentTarget.getBoundingClientRect();
    v.currentTime = ((e.clientX - rect.left) / rect.width) * v.duration;
  };

  const resetHideTimer = () => {
    clearTimeout(hideTimerRef.current);
    setShowControls(true);
    if (playing) hideTimerRef.current = setTimeout(() => setShowControls(false), 2500);
  };

  const fmt = (s: number) => {
    if (!Number.isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const setPlaybackSpeed = (s: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = s;
    setSpeed(s);
    setShowSpeedMenu(false);
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      el.requestFullscreen();
    }
  };

  // 监听全屏变化（用户可能按 Esc 退出）
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // 倍速菜单打开时，点击外部关闭
  useEffect(() => {
    if (!showSpeedMenu) return;
    const handler = () => setShowSpeedMenu(false);
    // 延迟绑定避免立即触发
    const id = setTimeout(() => document.addEventListener("click", handler), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("click", handler);
    };
  }, [showSpeedMenu]);

  return (
    <div>
      <p
        className="text-[12px] text-text-muted mb-1 truncate flex items-center gap-1 cursor-pointer hover:text-primary transition-colors group/title"
        title={url}
        onClick={handleCopy}
      >
        <Clapperboard className="h-3 w-3 shrink-0 text-amber-500/70" />
        <span className="truncate">{copied ? "已复制 ✓" : fileName}</span>
        <Copy className="h-3 w-3 shrink-0 opacity-0 group-hover/title:opacity-100 transition-opacity ml-0.5" />
      </p>
      <div
        ref={containerRef}
        data-video-src={url}
        className={cn(
          "relative bg-black group/player",
          isFullscreen ? "fixed inset-0 z-50 w-screen h-screen" : "rounded-xl overflow-hidden shadow-lg",
        )}
        style={{ maxWidth: isFullscreen ? undefined : "100%" }}
        onMouseMove={resetHideTimer}
        onMouseLeave={() => clearTimeout(hideTimerRef.current)}
      >
        <video
          ref={videoRef}
          src={url}
          preload="metadata"
          className={cn(
            "block cursor-pointer",
            isFullscreen ? "absolute inset-0 w-full h-full object-contain" : "w-full max-w-full",
          )}
          style={{ maxHeight: isFullscreen ? undefined : 360 }}
          onError={() => setError(true)}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onClick={togglePlay}
        />

        {/* 居中大播放按钮 — 暂停时始终可见 */}
        {!playing && !error && (
          <div
            className="absolute inset-0 flex items-center justify-center bg-black/10 cursor-pointer"
            onClick={togglePlay}
          >
            <div
              className={cn(
                "flex items-center justify-center rounded-full bg-white/90 group-hover/player:bg-white transition-colors shadow-xl",
                isFullscreen ? "h-20 w-20" : "h-14 w-14",
              )}
            >
              <Play className={cn("text-black", isFullscreen ? "h-8 w-8 ml-1" : "h-6 w-6 ml-0.5")} />
            </div>
          </div>
        )}

        {/* 自定义底部控件栏 */}
        <div
          className={cn(
            "absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent transition-opacity duration-300",
            isFullscreen ? "px-6 pb-8 pt-20" : "px-3 pb-3 pt-10",
            showControls ? "opacity-100" : "opacity-0 pointer-events-none",
          )}
        >
          {/* 进度条 */}
          <div
            className={cn(
              "bg-white/25 rounded-full cursor-pointer group/progress transition-all",
              isFullscreen ? "h-2 mb-3 hover:h-3" : "h-1 mb-2.5 hover:h-1.5",
            )}
            onClick={seek}
          >
            <div
              className="h-full bg-white rounded-full relative transition-all duration-100"
              style={{ width: `${progress}%` }}
            >
              <div
                className={cn(
                  "absolute right-0 top-1/2 -translate-y-1/2 rounded-full bg-white shadow scale-0 group-hover/progress:scale-100 transition-transform",
                  isFullscreen ? "h-4 w-4" : "h-3 w-3",
                )}
              />
            </div>
          </div>
          {/* 控件按钮行 */}
          <div className={cn("flex items-center justify-between text-white", isFullscreen ? "text-sm" : "text-[12px]")}>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={togglePlay}
                className={cn("hover:opacity-80 transition-opacity", isFullscreen && "p-1")}
              >
                {playing ? (
                  <Pause className={isFullscreen ? "h-6 w-6" : "h-4 w-4"} />
                ) : (
                  <Play className={isFullscreen ? "h-6 w-6" : "h-4 w-4"} />
                )}
              </button>
              <span className="tabular-nums opacity-70">
                {fmt(videoRef.current?.currentTime ?? 0)} / {fmt(duration)}
              </span>
            </div>
            <div className={cn("flex items-center", isFullscreen ? "gap-2" : "gap-1")}>
              {/* 倍速 — 点击展开下拉菜单 */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                  className={cn(
                    "rounded font-medium hover:bg-white/20 transition-colors tabular-nums",
                    isFullscreen ? "px-2.5 py-1 text-[14px]" : "px-1.5 py-0.5 text-[11px]",
                  )}
                >
                  {speed}×
                </button>
                {showSpeedMenu && (
                  <div className="absolute bottom-full right-0 mb-1 bg-black/90 backdrop-blur rounded-lg py-1 shadow-xl border border-white/10 min-w-[60px]">
                    {SPEEDS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setPlaybackSpeed(s)}
                        className={cn(
                          "block w-full text-left px-3 py-1.5 hover:bg-white/15 transition-colors tabular-nums",
                          s === speed ? "text-white font-medium" : "text-white/70",
                          isFullscreen ? "text-[14px]" : "text-[12px]",
                        )}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* 音量 */}
              <button
                type="button"
                onClick={toggleMute}
                className={cn("hover:bg-white/20 rounded transition-colors", isFullscreen ? "p-1.5" : "p-1")}
              >
                {muted ? (
                  <VolumeX className={isFullscreen ? "h-5 w-5" : "h-3.5 w-3.5"} />
                ) : (
                  <Volume2 className={isFullscreen ? "h-5 w-5" : "h-3.5 w-3.5"} />
                )}
              </button>
              {/* 全屏 */}
              <button
                type="button"
                onClick={toggleFullscreen}
                className={cn("hover:bg-white/20 rounded transition-colors", isFullscreen ? "p-1.5" : "p-1")}
              >
                <FullscreenIcon className={isFullscreen ? "h-5 w-5" : "h-3.5 w-3.5"} />
              </button>
            </div>
          </div>
        </div>

        {/* 错误遮罩 */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 pointer-events-none rounded-xl">
            <div className="flex flex-col items-center gap-1 text-white/80">
              <AlertCircle className="h-6 w-6" />
              <span className="text-[12px]">视频链接无效或无法访问</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 单个图片预览器：文件名标签 + 图片，加载失败叠加半透明遮罩。样式与 VideoPlayerCard 保持一致 */
export function ImagePreviewCard({ url }: { url: string }) {
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileName = url.split("/").pop()?.split("?")[0] ?? url;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 兜底，忽略失败
    }
  };

  // 外部图片走后端代理，绕过浏览器 Referer 防盗链拦截
  const proxyUrl =
    url.startsWith("http://") || url.startsWith("https://") ? `/web/proxy/image?url=${encodeURIComponent(url)}` : url;

  return (
    <div>
      <p
        className="text-[12px] text-text-muted mb-1 truncate flex items-center gap-1 cursor-pointer hover:text-primary transition-colors group/title"
        title={url}
        onClick={handleCopy}
      >
        <Images className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{copied ? "已复制 ✓" : fileName}</span>
        <Copy className="h-3 w-3 shrink-0 opacity-0 group-hover/title:opacity-100 transition-opacity ml-0.5" />
      </p>
      <div className="relative inline-block rounded-lg overflow-hidden" style={{ maxWidth: "100%" }}>
        <img
          src={proxyUrl}
          alt={fileName}
          loading="lazy"
          onError={() => setError(true)}
          className="block max-w-full rounded-lg"
          style={{ maxHeight: 400, objectFit: "contain", display: error ? "none" : "block" }}
        />
        {error && (
          <div
            className="flex items-center justify-center bg-muted rounded-lg pointer-events-none"
            style={{ minHeight: 120, minWidth: 200 }}
          >
            <div className="flex flex-col items-center gap-1 text-text-muted">
              <AlertCircle className="h-6 w-6" />
              <span className="text-[12px]">图片无法加载（链接无效或防盗链拦截）</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

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
        // 使用新的 /fs/ 路由代理整个 workspace 目录（不再限定 user/ 作用域）
        const match = url.match(/^(?:\.?\/)?(user\/.*)$/);
        if (match) {
          return `/web/environments/${envId}/fs/${match[1]}?preview=true`;
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
        img: ({ src, alt, ...rest }: Record<string, unknown>) => {
          const rawSrc = (src as string) || "";
          // 外部图片走后端代理，绕过 Referer 防盗链（与 ImagePreviewCard 一致）
          const imgSrc =
            rawSrc.startsWith("http://") || rawSrc.startsWith("https://")
              ? `/web/proxy/image?url=${encodeURIComponent(rawSrc)}`
              : rawSrc;
          return (
            <img
              src={imgSrc}
              alt={(alt as string) || ""}
              loading="lazy"
              style={{ maxWidth: "100%", maxHeight: "50vh", objectFit: "contain" }}
              {...Object.fromEntries(Object.entries(rest).filter(([k]) => !["children", "node"].includes(k)))}
            />
          );
        },
        iframe: (props: Record<string, unknown>) => <IframePreview {...props} />,
        // 保留默认链接渲染，确保正文中的链接正常显示
        a: ({ href, children, ...rest }: Record<string, unknown>) => {
          const hrefStr = (href as string) || "";
          // 拦截 /citation/ 相对路径链接，渲染为可点击的引用链接
          const citationMatch = hrefStr.match(/^\/citation\/([^/]+)\/(.+)$/);
          if (citationMatch) {
            return (
              <CitationLink resourceId={citationMatch[1]} kbId={citationMatch[2]}>
                {children as React.ReactNode}
              </CitationLink>
            );
          }
          return (
            <a
              href={hrefStr}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
              {...Object.fromEntries(Object.entries(rest).filter(([k]) => !["children", "node"].includes(k)))}
            >
              {children as React.ReactNode}
            </a>
          );
        },
      };
      const registered = getRegisteredComponents();
      return { ...base, ...registered } as Components;
    }, []);

    // 从消息文本中提取视频 URL（.mp4/.webm/.mov 等），保留链接在正文中，播放器放最下方
    const videoUrls = useMemo(() => {
      if (!children) return [];
      const regex = /https?:\/\/[^\s<>"']+\.(mp4|webm|mov|avi|mkv|ogv|ogg)(\?[^\s<>"']*)?/gi;
      const seen = new Set<string>();
      const result: string[] = [];
      for (const match of children.matchAll(regex)) {
        const url = match[0];
        if (!seen.has(url)) {
          seen.add(url);
          result.push(url);
        }
      }
      return result;
    }, [children]);

    // 从消息文本中提取图片 URL（.jpg/.png/.gif/.webp 等），与视频同理：保留链接在正文中，预览器放最下方
    const imageUrls = useMemo(() => {
      if (!children) return [];
      const regex = /https?:\/\/[^\s<>"']+\.(png|jpe?g|gif|webp|bmp|svg|avif)(\?[^\s<>"']*)?/gi;
      const seen = new Set<string>();
      const result: string[] = [];
      for (const match of children.matchAll(regex)) {
        const url = match[0];
        if (!seen.has(url)) {
          seen.add(url);
          result.push(url);
        }
      }
      return result;
    }, [children]);

    // 预处理正文，确保视频/图片链接不丢失：
    // 1. Agent 有时返回 <video src="url"> / <img src="url"> HTML 标签，streamdown 的 allowedTags 不含二者，
    //    整个标签会被过滤掉，导致链接所在行变成空白。这里把标签替换为裸 URL，保持原位。
    // 2. 再把裸 URL（含中文标点紧贴的情况）转为 markdown 链接，确保渲染为可点击链接。
    const processedChildren = useMemo(() => {
      if (!children) return children;
      let text = children;
      // 步骤 1：提取 <video ... src="url" ...> 的 src，替换为裸 URL（兼容单/双引号、自闭合与成对标签）
      text = text.replace(
        /<video\b[^>]*?\bsrc=["']([^"']+)["'][^>]*?\/?>(?:\s*<\/video>)?/gi,
        (_m, url: string) => `\n\n${url}\n\n`,
      );
      // 步骤 1.5：提取 <img ... src="url" ...> 的 src，替换为裸 URL（同理，兼容自闭合标签）
      text = text.replace(/<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*?\/?>/gi, (_m, url: string) => `\n\n${url}\n\n`);
      // 步骤 2：裸 URL → markdown 链接。负向后行断言排除 markdown 链接 ](url) / HTML 属性 ="url" 中已有的，
      // 避免重复包装破坏既有语法。字符集取 RFC 3986 合法字符（不含 []() 引号）。
      text = text.replace(/(?<!['"(])(https?:\/\/[A-Za-z0-9\-._~:/?#@!$&'*+,;=%]+)/g, (url) => `[${url}](${url})`);
      return text;
    }, [children]);

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
            {processedChildren ?? children}
          </LazyStreamdown>
          {/* 图片预览器：可收展，默认收起 */}
          {imageUrls.length > 0 && (
            <Collapsible defaultOpen={false} className="mt-3 group">
              <CollapsibleTrigger className="flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-card hover:bg-accent hover:border-accent-foreground/20 text-[14px] font-medium text-foreground/80 hover:text-foreground transition-all cursor-pointer select-none shadow-sm">
                <ChevronDown className="h-4 w-4 transition-transform duration-200 group-data-[state=open]:rotate-180 text-muted-foreground" />
                <span className="flex items-center justify-center h-6 w-6 rounded-full bg-blue-500/10">
                  <Images className="h-3.5 w-3.5 text-blue-500" />
                </span>
                <span>
                  共 <strong>{imageUrls.length}</strong> 张图片
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-3">
                {imageUrls.map((url) => (
                  <ImagePreviewCard key={url} url={url} />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
          {/* 视频播放器：可收展，默认收起 */}
          {videoUrls.length > 0 && (
            <Collapsible defaultOpen={false} className="mt-3 group" data-video-collapsible="true">
              <CollapsibleTrigger className="flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-border bg-card hover:bg-accent hover:border-accent-foreground/20 text-[14px] font-medium text-foreground/80 hover:text-foreground transition-all cursor-pointer select-none shadow-sm">
                <ChevronDown className="h-4 w-4 transition-transform duration-200 group-data-[state=open]:rotate-180 text-muted-foreground" />
                <span className="flex items-center justify-center h-6 w-6 rounded-full bg-amber-500/10">
                  <Clapperboard className="h-3.5 w-3.5 text-amber-500" />
                </span>
                <span>
                  共 <strong>{videoUrls.length}</strong> 个视频
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-3">
                {videoUrls.map((url) => (
                  <VideoPlayerCard key={url} url={url} />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
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
