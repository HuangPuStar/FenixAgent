/**
 * 待发送队列区（peri steer 的 steer 交互）：展示运行中提交、尚未注入 agent 会话的条目。
 *
 * 位置与宽度：贴在输入岛上方、与状态面板同宽（宽度台阶由渲染处 `../shell/ChatInterface` 从输入岛
 * 宽度容器派生，本组件不声明宽度，也不引 CSS 文件——结构用 tailwind 标准类名）。
 *
 * 事实源：条目全部来自 Session Doc `userInputQueue` 投影（props 注入），组件不持有副本、不做乐观
 * 增删——按下按钮只发出控制面 action，界面等 Y.Doc 回推后收敛（与用户气泡由服务端写 Chat Doc 同源）。
 *
 * 状态呈现（对齐服务端状态机）：
 * - `queued`：显示「待发送」，提供单发（↑）与取回（↶）；
 * - `dispatching` / `claimed`：显示「发送中」并隐藏操作按钮（不可重复操作）；
 * - 其余状态（`unknown`）保守展示为「状态未知」且不可操作；
 * - `delivered` / `withdrawn` 不在投影里（渲染处不会收到）。
 *
 * 可访问性：区域有 `role="region"` + 标题 aria-label；三个操作都是原生 button，带 aria-label 与
 * title，键盘可达；失败提示用 `role="alert"` 播报，重试按钮是原生的可聚焦控件。
 */

import { AlertCircle, ArrowUp, ChevronsUp, Loader2, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";
import type { UserInputQueueItemState, UserInputQueueItemView } from "../shell/chat-interface-types";

/** 单项摘要的截断宽度：足够辨认内容，又不把队列区撑成整块正文。 */
const SUMMARY_CLASS = "min-w-0 flex-1 truncate text-xs text-text-primary";

interface UserInputQueuePanelProps {
  items: readonly UserInputQueueItemView[];
  /** state=queued 的项 id（「全部发送」的目标集合） */
  queuedIds: readonly string[];
  canDispatch: boolean;
  canTakeback: boolean;
  /** 单发（传一个 id）与全发（传全部 queued id）共用同一出口 */
  onDispatch: (inputIds: string[]) => void;
  onTakeback: (inputId: string) => void;
  failure: { message: string; retry: () => void } | null;
  onDismissFailure: () => void;
}

/** 状态文案键（`queued` 与 `unknown` 的正/异常展示；`delivered`/`withdrawn` 不会到达渲染层）。 */
function stateLabelKey(state: UserInputQueueItemState): string {
  switch (state) {
    case "dispatching":
    case "claimed":
      return "chat.components.userInputQueue.stateSending";
    case "unknown":
      return "chat.components.userInputQueue.stateUnknown";
    default:
      return "chat.components.userInputQueue.stateQueued";
  }
}

/** 是否处于「发送中」展示态（服务端已认领，不可重复操作）。 */
function isSending(state: UserInputQueueItemState): boolean {
  return state === "dispatching" || state === "claimed";
}

/** 输入框上方的待发送队列区；无条目且无失败提示时返回 null（空态不占位）。 */
export function UserInputQueuePanel({
  items,
  queuedIds,
  canDispatch,
  canTakeback,
  onDispatch,
  onTakeback,
  failure,
  onDismissFailure,
}: UserInputQueuePanelProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  if (items.length === 0 && !failure) return null;

  const title = t("chat.components.userInputQueue.title");

  return (
    <div
      className="mb-1 overflow-hidden rounded-lg border border-slate-200 bg-white/95 shadow-sm backdrop-blur-md"
      role="region"
      aria-label={title}
      data-slot="user-input-queue"
    >
      <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        <span className="text-3xs font-semibold tracking-wide text-text-muted uppercase">{title}</span>
        <span className="text-3xs text-text-muted" data-slot="user-input-queue-count">
          {items.length}
        </span>
        <button
          type="button"
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-3xs text-slate-500 hover:bg-slate-100 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => onDispatch([...queuedIds])}
          disabled={!canDispatch || queuedIds.length === 0}
          aria-label={t("chat.components.userInputQueue.dispatchAll")}
          title={t("chat.components.userInputQueue.dispatchAll")}
          data-slot="user-input-queue-dispatch-all"
        >
          <ChevronsUp className="h-3.5 w-3.5" />
          {t("chat.components.userInputQueue.dispatchAll")}
        </button>
      </div>

      <ul className="m-0 list-none p-0" data-slot="user-input-queue-items">
        {items.map((item) => {
          const sending = isSending(item.state);
          const operable = item.state === "queued";
          return (
            <li
              key={item.inputId}
              className="flex min-h-8 items-center gap-1.5 border-b border-slate-50 px-3 py-1 last:border-b-0"
              data-slot="user-input-queue-item"
              data-input-id={item.inputId}
              data-state={item.state}
            >
              <span className={SUMMARY_CLASS} title={item.content}>
                {item.content}
              </span>
              {sending ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-3xs text-brand">
                  <Loader2 className="h-3.25 w-3.25 animate-spin" />
                  {t(stateLabelKey(item.state))}
                </span>
              ) : (
                <span className="shrink-0 text-3xs text-text-muted">{t(stateLabelKey(item.state))}</span>
              )}
              {operable && canDispatch ? (
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-brand"
                  onClick={() => onDispatch([item.inputId])}
                  aria-label={t("chat.components.userInputQueue.dispatchOne")}
                  title={t("chat.components.userInputQueue.dispatchOne")}
                  data-slot="user-input-queue-dispatch-one"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              ) : null}
              {operable && canTakeback ? (
                <button
                  type="button"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-brand"
                  onClick={() => onTakeback(item.inputId)}
                  aria-label={t("chat.components.userInputQueue.takeback")}
                  title={t("chat.components.userInputQueue.takeback")}
                  data-slot="user-input-queue-takeback"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* 失败提示：动作没写进 socket 时用户既看不到条目变化也没有回执，必须给出原因与重试入口 */}
      {failure ? (
        <div
          className="flex items-center gap-2 border-t border-red-100 bg-red-50 px-3 py-1.5 text-3xs text-red-700"
          role="alert"
          data-slot="user-input-queue-error"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{failure.message}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-3xs text-red-700 hover:bg-red-100 hover:text-red-800"
            onClick={failure.retry}
            aria-label={t("chat.components.userInputQueue.retry")}
            data-slot="user-input-queue-retry"
          >
            {t("chat.components.userInputQueue.retry")}
          </Button>
          <button
            type="button"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-red-500 hover:bg-red-100 hover:text-red-700"
            onClick={onDismissFailure}
            aria-label={t("chat.components.userInputQueue.dismiss")}
            title={t("chat.components.userInputQueue.dismiss")}
            data-slot="user-input-queue-dismiss"
          >
            {"\u00D7"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
