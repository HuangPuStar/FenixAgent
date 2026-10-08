import { Tabs, TabsList, TabsTrigger } from "@fenix/ui-components/ui/tabs";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Activity, CheckCircle2, Clock3, PauseCircle, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TaskV2Info } from "../../../api/tasks-v2";
import { describeCron } from "../components/CronEditor";
import { projectCronOccurrences, projectTaskTime } from "./agent-tasks-utils";
import "./agent-task-runtime-board.css";

type Props = { tasks: TaskV2Info[]; loading: boolean };
type RuntimeWindow = 1 | 12 | 24;

const RUNTIME_WINDOWS: RuntimeWindow[] = [1, 12, 24];

export function AgentTaskRuntimeBoard({ tasks, loading }: Props) {
  const { t } = useTranslation(NS.TASKS_V2);
  const [now] = useState(() => Date.now());
  const [windowHours, setWindowHours] = useState<RuntimeWindow>(1);
  const axisPoints = windowHours === 24 ? 9 : 7;

  return (
    <section className="task-runtime-board overflow-hidden rounded-10 mx-0 mt-3.5 mb-4.5 bg-white" aria-busy={loading}>
      <header className="flex min-h-16.75 items-center justify-between gap-4.5 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="task-runtime-icon grid size-8.5 shrink-0 grow-0 basis-8.5 place-items-center rounded text-blue-600 bg-blue-50">
            <Activity className="w-4" />
          </span>
          <div>
            <h2 className="text-13 font-bold">{t("runtime.title", { hours: windowHours })}</h2>
            <p className="mt-0.75 text-3xs text-slate-400">{t("runtime.description")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Tabs
            value={String(windowHours)}
            onValueChange={(value) => {
              const hours = Number(value);
              if (hours === 1 || hours === 12 || hours === 24) setWindowHours(hours);
            }}
          >
            <TabsList aria-label={t("runtime.windowLabel")} className="h-8 rounded-md bg-surface-2 p-1">
              {RUNTIME_WINDOWS.map((hours) => (
                <TabsTrigger className="h-6 rounded px-2.5 text-3xs" key={hours} value={String(hours)}>
                  {t("runtime.windowHours", { hours })}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div
            className="task-runtime-legend flex flex-wrap justify-end gap-2.5 text-9 text-slate-500"
            role="group"
            aria-label={t("runtime.legendLabel")}
          >
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-2.75 text-emerald-600" />
              {t("status.success")}
            </span>
            <span className="flex items-center gap-1">
              <Clock3 className="w-2.75 text-brand" />
              {t("runtime.scheduled")}
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="w-2.75 text-red-500" />
              {t("status.failed")}
            </span>
            <span className="flex items-center gap-1">
              <PauseCircle className="w-2.75 text-yellow-500" />
              {t("runtime.paused")}
            </span>
          </div>
        </div>
      </header>
      <div className="task-runtime-scroll overflow-x-auto pt-2 px-4 pb-3.25">
        <div className="task-runtime-axis min-w-190 h-7">
          <span />
          <div className="relative">
            {Array.from({ length: axisPoints }, (_, index) => index).map((index) => (
              <time
                key={index}
                className="absolute bottom-1.75 text-8 text-slate-400"
                style={{ left: `${(index / (axisPoints - 1)) * 100}%` }}
              >
                {new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(
                  new Date(now + (windowHours * 3_600_000 * index) / (axisPoints - 1)),
                )}
              </time>
            ))}
          </div>
        </div>
        {tasks.map((task) => (
          <TaskRuntimeRow key={task.id} task={task} now={now} windowHours={windowHours} />
        ))}
        {tasks.length === 0 && (
          <p className="task-runtime-empty min-w-190 p-7 text-3xs text-center text-slate-400">
            {t("emptySearchResult")}
          </p>
        )}
      </div>
    </section>
  );
}

function TaskRuntimeRow({ task, now, windowHours }: { task: TaskV2Info; now: number; windowHours: RuntimeWindow }) {
  const { t } = useTranslation(NS.TASKS_V2);
  const last = projectTaskTime(task.lastRunAt, now, windowHours);
  const scheduled = useMemo(
    () => projectCronOccurrences(task.cron, task.timezone, now, task.nextRunAt, windowHours),
    [now, task.cron, task.nextRunAt, task.timezone, windowHours],
  );
  const fallbackNext = scheduled.length === 0 ? projectTaskTime(task.nextRunAt, now, windowHours) : null;
  const runWidth = Math.max((Math.min(task.timeoutSeconds, 3600) / (windowHours * 3_600)) * 100, 0.7);
  const lastState = task.lastStatus === "success" ? "success" : task.lastStatus === "failed" ? "failed" : "timeout";
  // 原 `.task-runtime-run.is-success | .is-failed | .is-timeout` 的底色已收口成条件类名（各态取最近色阶档）。
  const runTone = lastState === "success" ? "bg-emerald-500" : lastState === "failed" ? "bg-red-500" : "bg-yellow-500";
  return (
    <div className="task-runtime-row min-w-190 min-h-11">
      <div className="task-runtime-label flex min-w-0 flex-col justify-center gap-0.5 pr-4">
        <strong className="truncate text-3xs">{task.name}</strong>
        <span className="truncate text-8 text-slate-400">{describeCron(task.cron, t)}</span>
      </div>
      <div className="task-runtime-track relative">
        {last !== null && (
          <span
            className={`task-runtime-run absolute min-w-1.75 h-3.25 top-1/2 -translate-y-1/2 rounded-3 ${runTone}`}
            style={{ left: `${last}%`, width: `${runWidth}%` }}
            title={t(`status.${task.lastStatus ?? "pending"}`)}
          />
        )}
        {scheduled.length > 0 && (
          <svg
            className={
              task.enabled
                ? "absolute inset-0 h-full w-full overflow-visible text-brand"
                : "absolute inset-0 h-full w-full overflow-visible text-muted"
            }
            viewBox="0 0 1000 16"
            preserveAspectRatio="none"
            role="img"
            aria-label={task.enabled ? t("runtime.scheduled") : t("runtime.paused")}
          >
            <path
              className="fill-none stroke-current [stroke-linecap:round] [stroke-width:2] [vector-effect:non-scaling-stroke]"
              d={scheduled.map((position) => `M ${position * 10} 6 v 4`).join(" ")}
            />
          </svg>
        )}
        {fallbackNext !== null && (
          <span
            className={
              task.enabled
                ? "task-runtime-run absolute top-1/2 -translate-y-1/2 rounded-3 bg-brand"
                : "task-runtime-run absolute top-1/2 -translate-y-1/2 rounded-3 bg-slate-300"
            }
            style={{ left: `${fallbackNext}%`, width: `${runWidth}%` }}
            title={task.enabled ? t("runtime.scheduled") : t("runtime.paused")}
          />
        )}
        {last === null && scheduled.length === 0 && fallbackNext === null && (
          <i className="absolute top-1/2 left-2 -translate-y-1/2 text-8 text-slate-300 not-italic">
            {t("runtime.outsideWindow")}
          </i>
        )}
      </div>
    </div>
  );
}
