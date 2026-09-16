import { Activity, CheckCircle2, Clock3, PauseCircle, XCircle } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { TaskV2Info } from "@/src/api/tasks-v2";
import { NS } from "@/src/i18n";
import { describeCron } from "../components/CronEditor";
import { projectCronOccurrences, projectTaskTime } from "./agent-tasks-utils";
import "./agent-tasks.css";

type Props = { tasks: TaskV2Info[]; loading: boolean };
type RuntimeWindow = 1 | 12 | 24;

const RUNTIME_WINDOWS: RuntimeWindow[] = [1, 12, 24];

export function AgentTaskRuntimeBoard({ tasks, loading }: Props) {
  const { t } = useTranslation(NS.TASKS_V2);
  const [now] = useState(() => Date.now());
  const [windowHours, setWindowHours] = useState<RuntimeWindow>(1);
  const axisPoints = windowHours === 24 ? 9 : 7;

  return (
    <section className="task-runtime-board" aria-busy={loading}>
      <header>
        <div>
          <span className="task-runtime-icon">
            <Activity />
          </span>
          <div>
            <h2>{t("runtime.title", { hours: windowHours })}</h2>
            <p>{t("runtime.description")}</p>
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
                <TabsTrigger className="h-6 rounded px-2.5 text-[10px]" key={hours} value={String(hours)}>
                  {t("runtime.windowHours", { hours })}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="task-runtime-legend" role="group" aria-label={t("runtime.legendLabel")}>
            <span>
              <CheckCircle2 className="is-success" />
              {t("status.success")}
            </span>
            <span>
              <Clock3 className="is-running" />
              {t("runtime.scheduled")}
            </span>
            <span>
              <XCircle className="is-failed" />
              {t("status.failed")}
            </span>
            <span>
              <PauseCircle className="is-paused" />
              {t("runtime.paused")}
            </span>
          </div>
        </div>
      </header>
      <div className="task-runtime-scroll">
        <div className="task-runtime-axis">
          <span />
          <div>
            {Array.from({ length: axisPoints }, (_, index) => index).map((index) => (
              <time key={index} style={{ left: `${(index / (axisPoints - 1)) * 100}%` }}>
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
        {tasks.length === 0 && <p className="task-runtime-empty">{t("emptySearchResult")}</p>}
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
  return (
    <div className="task-runtime-row">
      <div className="task-runtime-label">
        <strong>{task.name}</strong>
        <span>{describeCron(task.cron, t)}</span>
      </div>
      <div className="task-runtime-track">
        {last !== null && (
          <span
            className={`task-runtime-run is-${lastState}`}
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
            className={task.enabled ? "task-runtime-run is-scheduled" : "task-runtime-run is-paused"}
            style={{ left: `${fallbackNext}%`, width: `${runWidth}%` }}
            title={task.enabled ? t("runtime.scheduled") : t("runtime.paused")}
          />
        )}
        {last === null && scheduled.length === 0 && fallbackNext === null && <i>{t("runtime.outsideWindow")}</i>}
      </div>
    </div>
  );
}
