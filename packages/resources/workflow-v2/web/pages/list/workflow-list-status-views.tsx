// pages/list/workflow-list-status-views.tsx
// 列表页的**非交互态呈现**：骨架、空态、失败 / 无权限、上游未就绪。
//
// 与画布宿主页同款结构（`pages/canvas/canvas-status-views.tsx`）：空态 / 失败 / 无权限共用 `EmptyState`
// 骨架，差别只在措辞、动作与色调。这里不做第二套「加载失败组件」——那会让「这次算空态还是错误态」
// 在每个调用点重复判断（§4.1）。
//
// 动作在这一层定型：哪个状态给「重试」、哪个状态**还有**一个能改变状态本身的主动作（未绑定态的初始化），
// 都由 `describeStatus` 一个纯函数给出；回调由页面注入——本文件不认识网络（§3.5）。
//
// 文案一律 `t()` + 字面量键：这些状态是有限枚举，写死即可被包内 i18n 用例静态覆盖（动态拼键只在运行时
// 暴露缺项）。

import { EmptyState, type EmptyStateTone } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { AlertTriangle, Inbox, Link2Off, Plus, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WORKFLOW_NS } from "../../i18n/namespace";
import { WORKFLOW_GRID_CLASS, type WorkflowListViewState } from "./workflow-list-model";

/** 骨架 / 空态 / 失败之外的状态（渲染表格与骨架的两种状态由调用方分支）。 */
export type WorkflowListInactiveState = Exclude<WorkflowListViewState, { kind: "loading" } | { kind: "ready" }>;

/** `t` 的最小签名；用于在组件外描述状态（包内不引入域外类型）。 */
type Translate = (key: string) => string;

/**
 * 状态块的**主动作**：能真正改变状态的那个动作（未绑定态的「初始化工作流空间」）。
 *
 * 只给呈现（标签 + 图标）不给回调：模型层不认识网络，回调由页面注入（见 `WorkflowListStatusViewProps`）。
 */
interface ListPrimaryAction {
  readonly label: string;
  readonly icon: ReactNode;
}

/** 状态卡的描述：图标 + 文案 + 色调 + 是否给重试 + 主动作 + 是否 `role="alert"`。 */
interface ListStatusDescription {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly tone: EmptyStateTone;
  /** 是否给「重试」（重新探测列表与租户绑定）；无权限与空态固定不给。 */
  readonly retryable: boolean;
  /** 主路径之外**还能主动做点什么**时给出的动作；没有则为 null（此时「重试」就是唯一的动作）。 */
  readonly primaryAction: ListPrimaryAction | null;
}

/** 状态图标统一尺寸（不写尺寸类时 `EmptyState` 用 lucide 默认的 24px，与既有页面不一致）。 */
const ICON_CLASS = "size-6";

/**
 * 卡片骨架的占位键（与 `workflow-list-cards.tsx` 的网格同形）：取数完成时的跳动只发生在文字行上。
 *
 * 键写成固定字面量而不是数组下标：下标做 key 是 biome 的 `noArrayIndexKey` 禁则，且骨架是静态占位，
 * 复用同一组常量没有身份问题。
 */
const SKELETON_CARD_KEYS = ["card-1", "card-2", "card-3", "card-4", "card-5", "card-6"] as const;

export function WorkflowListSkeleton() {
  const { t } = useTranslation(WORKFLOW_NS);
  // `role="status"` + `aria-busy` 让读屏知道这里是「正在加载」而不是空列表；骨架本身没有可读文案，
  // 语义靠 `aria-label` 补（与旧列表页同款）。
  return (
    <div aria-busy="true" aria-label={t("list.loading")} className={WORKFLOW_GRID_CLASS} role="status">
      {SKELETON_CARD_KEYS.map((key) => (
        <div key={key} aria-hidden="true" className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-3 p-5 pb-4">
            <Skeleton className="size-10 rounded-xl" />
            <Skeleton className="h-5 w-2/3" />
          </div>
          <div className="space-y-3 px-5 pb-4">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-4 w-36" />
          </div>
          <div className="flex justify-between border-t px-4 py-3">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 未就绪 / 失败的统一描述；无权限固定不给重试，其余都可重试（重试即重查列表与租户绑定）。 */
function describeStatus(state: WorkflowListInactiveState, t: Translate): ListStatusDescription {
  switch (state.kind) {
    case "empty":
      return {
        icon: <Inbox className={ICON_CLASS} />,
        title: t("list.no_workflows"),
        description: t("list.no_workflows_hint"),
        // 空是合法结果而不是错误：不给 `danger`、不给 `role="alert"`。
        tone: "neutral",
        retryable: false,
        primaryAction: null,
      };
    case "unauthorized":
      return {
        icon: <ShieldAlert className={ICON_CLASS} />,
        title: t("list.unauthorized_title"),
        description: t("list.unauthorized_hint"),
        tone: "danger",
        // 401/403 重试只会重复被拒（§4.1）。
        retryable: false,
        primaryAction: null,
      };
    case "blocked":
      return state.reason === "unbound"
        ? {
            icon: <Link2Off className={ICON_CLASS} />,
            title: t("list.blocked.unbound.title"),
            description: t("list.blocked.unbound.description"),
            // 「尚未绑定」可自愈（绑定后重试即可），不按 danger 告警。
            tone: "neutral",
            retryable: true,
            // 唯一的自愈入口：`POST /org-app` 建绑（幂等，任意成员可调用）。没有它，新组织会永久停在这一屏——
            // 重试只能「重新探测」，永远改变不了未绑定这个事实。
            primaryAction: { label: t("list.blocked.unbound.initialize"), icon: <Plus className="size-4" /> },
          }
        : {
            icon: <WifiOff className={ICON_CLASS} />,
            title: t("list.blocked.degraded.title"),
            description: t("list.blocked.degraded.description"),
            tone: "danger",
            retryable: true,
            // 上游把目标 App 判为不可用：控制台没有能改变它的动作，只能重试探测。
            primaryAction: null,
          };
    default:
      return {
        icon: <AlertTriangle className={ICON_CLASS} />,
        title: t("list.load_failed"),
        description: t("list.load_failed_hint"),
        tone: "danger",
        retryable: true,
        primaryAction: null,
      };
  }
}

export interface WorkflowListStatusViewProps {
  readonly state: WorkflowListInactiveState;
  readonly onRetry: () => void;
  readonly onCreate: () => void;
  /** 主动作（一键初始化工作流空间）的回调；只有未绑定态会渲染它，其余状态传入也不会被调用。 */
  readonly onInitialize: () => void;
  /**
   * 初始化是否在途：在途时主动作置灰并换成进行中文案。
   *
   * 首次初始化会顺带引导平台账号（登录 + 落库），耗时明显长于普通请求——没有进行中反馈的按钮会被连点，
   * 而连点虽然被服务端幂等收敛，用户仍会以为「没点上」。
   */
  readonly initializing: boolean;
}

/**
 * 空态 / 失败 / 无权限 / 上游未就绪的统一状态块。失败类状态一律 `role="alert"`，空态不打断读屏。
 *
 * 动作的两种排布：只有一个动作时它占 `EmptyState` 的 `action` 槽（与既有观感一致）；未绑定态有两个动作
 * （初始化 + 重试），主按钮仍占槽位，「重试」另起一行弱化为次要按钮——`EmptyState` 的槽位只放得下一个按钮，
 * 同排就要绕开它自绘动作行，那会让各状态的动作排版分成两套。
 *
 * 两个动作时把状态块自身的下内距收掉（`pb-2`），否则那一行会空出一整段（`py-10` 是给「块到此结束」用的）。
 * 覆盖成立靠 Tailwind 的产出顺序（`.pb-*` 排在 `.py-*` 之后，与 `p` → `px`/`py` → `pt`/`pb` 的档位顺序一致），
 * 不是 `cn` 替我们消解：`twMerge` 只认同一冲突族内的完整覆盖，`py-10` 与 `pb-2` 会被一起保留、由样式表顺序定胜负。
 */
export function WorkflowListStatusView({
  state,
  onRetry,
  onCreate,
  onInitialize,
  initializing,
}: WorkflowListStatusViewProps) {
  const { t } = useTranslation(WORKFLOW_NS);
  const { icon, title, description, tone, retryable, primaryAction } = describeStatus(state, t);
  const stackedRetry = primaryAction !== null && retryable;

  return (
    <>
      <EmptyState
        icon={icon}
        title={title}
        description={description}
        tone={tone}
        role={tone === "danger" ? "alert" : undefined}
        className={
          stackedRetry
            ? "rounded-xl border border-border-subtle bg-card pb-2"
            : "rounded-xl border border-border-subtle bg-card py-16"
        }
        action={
          state.kind === "empty"
            ? { label: t("list.create"), onClick: onCreate, icon: <Plus className="size-4" /> }
            : primaryAction
              ? {
                  label: initializing ? t("list.blocked.unbound.initializing") : primaryAction.label,
                  icon: primaryAction.icon,
                  onClick: onInitialize,
                  disabled: initializing,
                }
              : retryable
                ? { label: t("list.retry"), onClick: onRetry, icon: <RefreshCw className="size-4" /> }
                : undefined
        }
      />
      {stackedRetry ? (
        // 主动作存在时「重试」降为次要动作：它不再是唯一出路，但仍是「别人刚把绑定做好」时的恢复路径。
        // 初始化在途时一并置灰：两条请求会各自重取绑定，回来的是同一个未绑定快照。
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={onRetry} disabled={initializing}>
            <RefreshCw className="size-4" />
            {t("list.retry")}
          </Button>
        </div>
      ) : null}
    </>
  );
}
