import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@fenix/ui-components/ui/dropdown-menu";
import { Input } from "@fenix/ui-components/ui/input";
import { Switch } from "@fenix/ui-components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import type { AgentInfo } from "@fenix/web-runtime/types/config";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  MinusCircle,
  MoreHorizontal,
  Pencil,
  Play,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { HttpDefinition, TaskV2Info } from "../../../api/tasks-v2";
import { describeCron } from "../components/CronEditor";
import { formatTaskRelativeTime } from "./agent-tasks-utils";
import "./agent-tasks-registry.css";

type TaskTypeFilter = "all" | "http" | "agent";
type Props = {
  tasks: TaskV2Info[];
  agents: AgentInfo[];
  query: string;
  page: number;
  totalPages: number;
  triggeringIds: Set<string>;
  onPageChange: (page: number) => void;
  onCreate: () => void;
  onToggle: (task: TaskV2Info) => void;
  onTrigger: (task: TaskV2Info) => void;
  onEdit: (task: TaskV2Info) => void;
  onDelete: (task: TaskV2Info) => void;
  onLogs: (task: TaskV2Info) => void;
};

export function AgentTasksRegistry(props: Props) {
  const { t } = useTranslation(NS.TASKS_V2);
  return (
    <section className="task-registry-section">
      {props.tasks.length === 0 ? (
        <div className="task-registry-empty grid min-h-57.5 place-content-center justify-items-center gap-1.5 text-center text-slate-400">
          <strong className="text-sm text-slate-800">{props.query.trim() ? t("emptySearchResult") : t("empty")}</strong>
          <p className="text-3xs">{t("subtitle")}</p>
          {!props.query.trim() && (
            <Button className="mt-2" onClick={props.onCreate}>
              {t("action.create")}
            </Button>
          )}
        </div>
      ) : (
        <div className="task-table-wrap overflow-auto border border-slate-200 rounded-10 bg-white">
          <Table className="min-w-230 table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="h-9.5 text-3xs text-slate-400 bg-slate-50">{t("table.name")}</TableHead>
                <TableHead className="h-9.5 text-3xs text-slate-400 bg-slate-50">{t("table.type")}</TableHead>
                <TableHead className="h-9.5 text-3xs text-slate-400 bg-slate-50">{t("table.target")}</TableHead>
                <TableHead className="h-9.5 text-3xs text-slate-400 bg-slate-50">{t("table.schedule")}</TableHead>
                <TableHead className="h-9.5 text-3xs text-slate-400 bg-slate-50">{t("table.lastRun")}</TableHead>
                <TableHead className="h-9.5 text-3xs text-right text-slate-400 bg-slate-50">
                  {t("table.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  agents={props.agents}
                  triggering={props.triggeringIds.has(task.id)}
                  onToggle={() => props.onToggle(task)}
                  onTrigger={() => props.onTrigger(task)}
                  onEdit={() => props.onEdit(task)}
                  onDelete={() => props.onDelete(task)}
                  onLogs={() => props.onLogs(task)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {props.totalPages > 1 && (
        <nav
          className="task-pagination flex items-center justify-center gap-2.25 pt-3.5 text-3xs text-slate-500"
          aria-label={t("registry.paginationLabel")}
        >
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-3xs"
            disabled={props.page <= 1}
            onClick={() => props.onPageChange(props.page - 1)}
          >
            <ChevronLeft className="size-3" />
            {t("log.prev")}
          </Button>
          <span>
            {props.page} / {props.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-3xs"
            disabled={props.page >= props.totalPages}
            onClick={() => props.onPageChange(props.page + 1)}
          >
            {t("log.next")}
            <ChevronRight className="size-3" />
          </Button>
        </nav>
      )}
    </section>
  );
}

export function AgentTasksToolbar({
  query,
  typeFilter,
  onQueryChange,
  onTypeFilterChange,
}: {
  query: string;
  typeFilter: TaskTypeFilter;
  onQueryChange: (value: string) => void;
  onTypeFilterChange: (value: TaskTypeFilter) => void;
}) {
  const { t } = useTranslation(NS.TASKS_V2);
  return (
    <div className="task-commandbar flex items-center gap-3 mx-0 mt-3.5 mb-3">
      <label className="task-search-field relative block">
        <Search className="absolute top-1/2 left-3.5 z-1 w-4 -translate-y-1/2 text-slate-400" />
        <TaskSearchInput value={query} onChange={onQueryChange} placeholder={t("filter.searchPlaceholder")} />
      </label>
      <div
        className="task-type-filter flex h-10 items-center gap-0.5 rounded bg-slate-200 p-1"
        role="group"
        aria-label={t("filter.typeLabel")}
      >
        {(["all", "http", "agent"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="h-8 rounded-md border-0 px-3.25 py-0 text-xs text-slate-500 bg-transparent"
            aria-pressed={typeFilter === value}
            onClick={() => onTypeFilterChange(value)}
          >
            {value === "all" ? t("filter.all") : t(`type.${value}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function TaskRow({
  task,
  agents,
  triggering,
  onToggle,
  onTrigger,
  onEdit,
  onDelete,
  onLogs,
}: {
  task: TaskV2Info;
  agents: AgentInfo[];
  triggering: boolean;
  onToggle: () => void;
  onTrigger: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onLogs: () => void;
}) {
  const { t } = useTranslation(NS.TASKS_V2);
  const agent = task.type === "agent" ? agents.find((item) => item.id === task.agentId) : null;
  const target =
    task.type === "agent" ? (agent?.name ?? task.agentId ?? "—") : ((task.definition as HttpDefinition).url ?? "—");
  return (
    <TableRow className={task.enabled ? "" : "is-disabled"}>
      <TableCell className="h-14.25 text-11">
        <button
          type="button"
          className="task-name-button flex min-w-0 items-center gap-2.25 border-0 text-inherit bg-transparent text-left"
          onClick={onEdit}
        >
          <span
            className={
              task.enabled
                ? "task-state-dot size-1.75 shrink-0 grow-0 basis-1.75 rounded-full bg-emerald-600"
                : "task-state-dot size-1.75 shrink-0 grow-0 basis-1.75 rounded-full bg-slate-400"
            }
          />
          <span className="block min-w-0">
            <strong className="block min-w-0 text-11">{task.name}</strong>
            {task.description && (
              <small className="block min-w-0 max-w-55 mt-0.5 truncate text-9 text-slate-400">{task.description}</small>
            )}
          </span>
        </button>
      </TableCell>
      <TableCell className="h-14.25 text-11">
        <Badge variant={task.type === "agent" ? "default" : "outline"}>{t(`type.${task.type}`)}</Badge>
      </TableCell>
      <TableCell className="h-14.25 text-11">
        <span className="task-target block max-w-47.5 truncate" title={target}>
          {target}
        </span>
      </TableCell>
      <TableCell className="h-14.25 text-11">
        <span className="task-schedule flex flex-col gap-0.5">
          {describeCron(task.cron, t)}
          <code className="text-9 text-slate-400">{task.cron}</code>
        </span>
      </TableCell>
      <TableCell className="h-14.25 text-11">
        <LastRun status={task.lastStatus} time={formatTaskRelativeTime(task.lastRunAt, t)} />
      </TableCell>
      <TableCell className="h-14.25 text-11">
        <div className="flex items-center justify-end gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="task-icon-button h-7 w-7 p-0"
            disabled={triggering}
            onClick={onTrigger}
            title={t("action.execute")}
            aria-label={t("action.execute")}
          >
            {triggering ? <Loader2 className="animate-spin size-3.5" /> : <Play className="size-3.5" />}
          </Button>
          <Switch
            checked={task.enabled}
            onCheckedChange={onToggle}
            size="sm"
            aria-label={task.enabled ? t("card.disabled") : t("card.enabled")}
          />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* 纯图标触发器：可见文本只有三个点，可访问名只能由 aria-label 提供（title 只作鼠标悬停提示）。 */}
              <Button variant="ghost" size="sm" className="task-icon-button h-7 w-7 p-0" aria-label={t("action.more")}>
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil />
                {t("action.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onLogs}>
                <FileText />
                {t("action.logs")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 />
                {t("action.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
}

function LastRun({ status, time }: { status: string | null; time: string }) {
  const { t } = useTranslation(NS.TASKS_V2);
  const Icon =
    status === "success" ? CheckCircle2 : status === "failed" ? XCircle : status === "timeout" ? Clock : MinusCircle;
  // 原 `.task-last-run.is-success | .is-failed | .is-timeout > svg` 的取色已收口成条件类名（pending 不着色）。
  const iconTone =
    status === "success"
      ? "text-emerald-600"
      : status === "failed"
        ? "text-red-500"
        : status === "timeout"
          ? "text-yellow-500"
          : "";
  return (
    <span className={`task-last-run flex items-center gap-1.5 text-slate-500`}>
      <Icon className={`w-3.5 ${iconTone}`} />
      <span className="block">
        {status ? t(`status.${status}`) : t("status.pending")}
        <small className="block mt-0.25 text-9 text-slate-400">{time}</small>
      </span>
    </span>
  );
}

function TaskSearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    // 字号 13px 走 px 档令牌 `text-13`：`Input` 基类带 `text-base md:text-sm`，产物里 md 媒体块排在基础块之后，
    // 只钉一条 `text-13` 会在宽屏被 `md:text-sm`（14px）压过；故宽屏档显式再钉同一令牌（同值，不是两个值）。
    <Input
      className="h-10 rounded border-slate-200 pl-10.25 text-13 md:text-13 bg-white"
      value={composing ? draft : value}
      placeholder={placeholder}
      onCompositionStart={() => {
        setComposing(true);
        setDraft(value);
      }}
      onCompositionUpdate={(event) => setDraft((event.target as HTMLInputElement).value)}
      onCompositionEnd={(event) => {
        setComposing(false);
        setDraft("");
        onChange((event.target as HTMLInputElement).value);
      }}
      onChange={(event) => (composing ? setDraft(event.target.value) : onChange(event.target.value))}
    />
  );
}
