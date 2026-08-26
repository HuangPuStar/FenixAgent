import { Activity, CheckCircle2, Clock3, PauseCircle, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TaskV2Info } from "@/src/api/tasks-v2";
import { NS } from "@/src/i18n";
import { describeCron } from "../components/CronEditor";
import { projectTaskTime } from "./agent-tasks-utils";
import "./agent-tasks.css";

type Props = { tasks: TaskV2Info[]; loading: boolean };

export function AgentTaskRuntimeBoard({ tasks, loading }: Props) {
  const { t } = useTranslation(NS.TASKS_V2);
  const now = Date.now();
  const startHour = new Date(now).getHours();

  return (
    <section className="task-runtime-board" aria-busy={loading}>
      <header>
        <div>
          <span className="task-runtime-icon">
            <Activity />
          </span>
          <div>
            <h2>{t("runtime.title")}</h2>
            <p>{t("runtime.description")}</p>
          </div>
        </div>
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
      </header>
      <div className="task-runtime-scroll">
        <div className="task-runtime-axis">
          <span />
          <div>
            {Array.from({ length: 9 }, (_, index) => index * 3).map((offset) => (
              <time key={offset} style={{ left: `${(offset / 24) * 100}%` }}>
                {String((startHour + offset) % 24).padStart(2, "0")}:00
              </time>
            ))}
          </div>
        </div>
        {tasks.map((task) => (
          <TaskRuntimeRow key={task.id} task={task} now={now} />
        ))}
        {tasks.length === 0 && <p className="task-runtime-empty">{t("emptySearchResult")}</p>}
      </div>
    </section>
  );
}

function TaskRuntimeRow({ task, now }: { task: TaskV2Info; now: number }) {
  const { t } = useTranslation(NS.TASKS_V2);
  const last = projectTaskTime(task.lastRunAt, now);
  const next = projectTaskTime(task.nextRunAt, now);
  const runWidth = Math.max((Math.min(task.timeoutSeconds, 3600) / 86_400) * 100, 0.7);
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
        {next !== null && (
          <span
            className={task.enabled ? "task-runtime-run is-scheduled" : "task-runtime-run is-paused"}
            style={{ left: `${next}%`, width: `${runWidth}%` }}
            title={task.enabled ? t("runtime.scheduled") : t("runtime.paused")}
          />
        )}
        {last === null && next === null && <i>{t("runtime.outsideWindow")}</i>}
      </div>
    </div>
  );
}
