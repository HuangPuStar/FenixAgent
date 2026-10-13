// pages/canvas/canvas-status-views.tsx
// 画布宿主页的**非交互态呈现**：骨架、降级卡与它们的返回入口。
//
// 覆盖设计 §5.4 与 §6.2 要求的必备状态：loading（骨架）· 初始化超时（给重试）· 上游不可用（给重试）·
// 会话失效（覆盖层 + 返回列表）· 未绑定租户 App（引导）。
//
// 为什么不新造组件骨架：空态 / 失败 / 无权限刻意共用一个骨架（`EmptyState`），差别只在措辞与「要不要给
// 重试」；再长一个「加载失败组件」会让「这次算空态还是错误态」在每个调用点重复判断（前端规范 §4.1）。
//
// 文案全部经 `t()` 且用字面量键：动态拼键会让字典缺项在运行时才暴露（回退成 key 本身），而这里的键是
// 有限枚举，写死即可被包内 i18n 用例静态覆盖。

import { EMPTY_STATE_FILL_CLASS, EmptyState, type EmptyStateTone } from "@fenix/ui-components/config/EmptyState";
import { cn } from "@fenix/ui-components/lib/cn";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Clock, Link2Off, LogOut, RefreshCw, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WORKFLOW_NS } from "../../i18n/namespace";
import type { CanvasViewState } from "./canvas-hosting-model";

/** `t` 的最小签名；用于在组件外描述状态（包内不引入域外类型）。 */
type Translate = (key: string) => string;

/** 状态卡的描述：图标 + 文案 + 色调 + 是否给重试 + 是否 `role="alert"`。 */
interface CanvasStatusDescription {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly tone: EmptyStateTone;
  readonly retryable: boolean;
}

/** 失败卡上的图标统一尺寸（不写尺寸类时 `EmptyState` 用 lucide 默认的 24px，与既有页面不一致）。 */
const ICON_CLASS = "size-6";

/** 画布就绪前的等高骨架：形状对齐画布三栏（左节点面板 / 中间画布 / 右配置面板），减少就绪时的跳动。 */
function CanvasSkeleton() {
  return (
    <div aria-busy="true" className="flex h-full w-full flex-col gap-3 bg-background p-4">
      <Skeleton className="h-9 w-full shrink-0" />
      <div className="flex min-h-0 flex-1 gap-3">
        <Skeleton className="w-56 shrink-0" />
        <Skeleton className="flex-1" />
        <Skeleton className="w-72 shrink-0" />
      </div>
    </div>
  );
}

/** 未就绪 / 失败 / 会话失效的统一描述；`retryable` 只对画布自报错误起作用，其余失败固定可重试。 */
function describeStatus(state: Exclude<CanvasViewState, { kind: "loading" }>, t: Translate): CanvasStatusDescription {
  if (state.kind === "blocked") {
    switch (state.reason) {
      case "unbound":
        return {
          icon: <Link2Off className={ICON_CLASS} />,
          title: t("canvas.state.blocked.unbound.title"),
          description: t("canvas.state.blocked.unbound.description"),
          // 「尚未绑定」是空态而不是错误：它可自愈（绑定完成后重试即可），不按 danger 告警。
          tone: "neutral",
          retryable: true,
        };
      case "degraded":
        return {
          icon: <AlertTriangle className={ICON_CLASS} />,
          title: t("canvas.state.blocked.degraded.title"),
          description: t("canvas.state.blocked.degraded.description"),
          tone: "danger",
          retryable: true,
        };
      case "space-missing":
        return {
          icon: <AlertTriangle className={ICON_CLASS} />,
          title: t("canvas.state.blocked.spaceMissing.title"),
          description: t("canvas.state.blocked.spaceMissing.description"),
          tone: "danger",
          retryable: true,
        };
      default:
        return {
          icon: <WifiOff className={ICON_CLASS} />,
          title: t("canvas.state.blocked.probeFailed.title"),
          description: t("canvas.state.blocked.probeFailed.description"),
          tone: "danger",
          retryable: true,
        };
    }
  }

  switch (state.phase) {
    case "session-expired":
      return {
        icon: <LogOut className={ICON_CLASS} />,
        title: t("canvas.state.sessionExpired.title"),
        description: t("canvas.state.sessionExpired.description"),
        tone: "danger",
        // 会话已失效时重试没有意义（签发链路本身要的就是这个会话），恢复动作是重新登录后按深链回到本页。
        retryable: false,
      };
    case "timeout":
      return {
        icon: <Clock className={ICON_CLASS} />,
        title: t("canvas.state.timeout.title"),
        description: t("canvas.state.timeout.description"),
        tone: "danger",
        retryable: true,
      };
    case "load-failed":
      return {
        icon: <AlertTriangle className={ICON_CLASS} />,
        title: t("canvas.state.loadFailed.title"),
        description: t("canvas.state.loadFailed.description"),
        tone: "danger",
        retryable: true,
      };
    case "canvas-error":
      return {
        icon: <AlertTriangle className={ICON_CLASS} />,
        title: t("canvas.state.canvasError.title"),
        description: t("canvas.state.canvasError.description"),
        tone: "danger",
        retryable: state.retryable,
      };
    default:
      return {
        icon: <AlertTriangle className={ICON_CLASS} />,
        title: t("canvas.state.handshakeFailed.title"),
        description: t("canvas.state.handshakeFailed.description"),
        tone: "danger",
        retryable: true,
      };
  }
}

export interface CanvasStatusPanelProps {
  /** 页面状态；`frame` 分支下只应传入非 `interactive` 的阶段（`interactive` 时页面不渲染本组件）。 */
  readonly state: CanvasViewState;
  readonly onRetry: () => void;
}

/**
 * 覆盖层 / 整页状态块：骨架（loading、connecting）或降级卡（超时、加载失败、握手失败、画布报错、
 * 上游未就绪、会话失效）。降级卡一律附「返回列表」，让任何一条失败路径都还有出口。
 */
export function CanvasStatusPanel({ state, onRetry }: CanvasStatusPanelProps) {
  const { t } = useTranslation(WORKFLOW_NS);

  if (state.kind === "loading") return <CanvasSkeleton />;
  if (state.kind === "frame" && state.phase === "connecting") return <CanvasSkeleton />;

  const { icon, title, description, tone, retryable } = describeStatus(state, t);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-background px-6">
      <EmptyState
        icon={icon}
        title={title}
        description={description}
        tone={tone}
        role="alert"
        action={
          retryable
            ? { label: t("canvas.action.retry"), onClick: onRetry, icon: <RefreshCw className="size-4" /> }
            : undefined
        }
        className={EMPTY_STATE_FILL_CLASS}
      />
      <Link
        to="/agent/workflow"
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md px-3 text-xs text-brand",
          "transition-colors hover:text-brand-hover",
        )}
      >
        <ArrowLeft className="size-3.5" />
        {t("canvas.action.backToList")}
      </Link>
    </div>
  );
}

/** 状态播报的载体（`aria-live`）；放在页面上方，任何阶段变化都会被读屏念一次。 */
export function CanvasAnnouncement({ label }: { readonly label: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {label}
    </p>
  );
}
