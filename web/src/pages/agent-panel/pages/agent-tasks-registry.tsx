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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { HttpDefinition, TaskV2Info } from "@/src/api/tasks-v2";
import { NS } from "@/src/i18n";
import type { AgentInfo } from "@/src/types/config";
import { describeCron } from "../components/CronEditor";
import { formatTaskRelativeTime } from "./agent-tasks-utils";

type TaskTypeFilter = "all" | "http" | "agent";
type Props = {
  tasks: TaskV2Info[];
  agents: AgentInfo[];
  query: string;
  typeFilter: TaskTypeFilter;
  page: number;
  totalPages: number;
  triggeringIds: Set<string>;
  onQueryChange: (value: string) => void;
  onTypeFilterChange: (value: TaskTypeFilter) => void;
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
      <div className="task-commandbar">
        <label className="task-search-field">
          <Search />
          <TaskSearchInput
            value={props.query}
            onChange={props.onQueryChange}
            placeholder={t("filter.searchPlaceholder")}
          />
        </label>
        <div className="task-type-filter" role="group" aria-label={t("filter.typeLabel")}>
          {(["all", "http", "agent"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={props.typeFilter === value}
              onClick={() => props.onTypeFilterChange(value)}
            >
              {value === "all" ? t("filter.all") : t(`type.${value}`)}
            </button>
          ))}
        </div>
      </div>
      <header className="task-registry-heading">
        <div>
          <h2>{t("registry.title")}</h2>
          <p>{t("registry.summary", { count: props.tasks.length })}</p>
        </div>
      </header>
      {props.tasks.length === 0 ? (
        <div className="task-registry-empty">
          <strong>{props.query.trim() ? t("emptySearchResult") : t("empty")}</strong>
          <p>{t("subtitle")}</p>
          {!props.query.trim() && <Button onClick={props.onCreate}>{t("action.create")}</Button>}
        </div>
      ) : (
        <div className="task-table-wrap">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("table.name")}</TableHead>
                <TableHead>{t("table.type")}</TableHead>
                <TableHead>{t("table.target")}</TableHead>
                <TableHead>{t("table.schedule")}</TableHead>
                <TableHead>{t("table.lastRun")}</TableHead>
                <TableHead className="text-right">{t("table.actions")}</TableHead>
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
        <nav className="task-pagination" aria-label={t("registry.paginationLabel")}>
          <Button
            variant="outline"
            size="sm"
            disabled={props.page <= 1}
            onClick={() => props.onPageChange(props.page - 1)}
          >
            <ChevronLeft />
            {t("log.prev")}
          </Button>
          <span>
            {props.page} / {props.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={props.page >= props.totalPages}
            onClick={() => props.onPageChange(props.page + 1)}
          >
            {t("log.next")}
            <ChevronRight />
          </Button>
        </nav>
      )}
    </section>
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
      <TableCell>
        <button type="button" className="task-name-button" onClick={onEdit}>
          <span className={task.enabled ? "task-state-dot is-enabled" : "task-state-dot"} />
          <span>
            <strong>{task.name}</strong>
            {task.description && <small>{task.description}</small>}
          </span>
        </button>
      </TableCell>
      <TableCell>
        <Badge variant={task.type === "agent" ? "default" : "outline"}>{t(`type.${task.type}`)}</Badge>
      </TableCell>
      <TableCell>
        <span className="task-target" title={target}>
          {target}
        </span>
      </TableCell>
      <TableCell>
        <span className="task-schedule">
          {describeCron(task.cron, t)}
          <code>{task.cron}</code>
        </span>
      </TableCell>
      <TableCell>
        <LastRun status={task.lastStatus} time={formatTaskRelativeTime(task.lastRunAt, t)} />
      </TableCell>
      <TableCell>
        <div className="task-row-actions">
          <Button variant="ghost" size="sm" disabled={triggering} onClick={onTrigger} title={t("action.execute")}>
            {triggering ? <Loader2 className="animate-spin" /> : <Play />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <MoreHorizontal />
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
          <Switch
            checked={task.enabled}
            onCheckedChange={onToggle}
            size="sm"
            aria-label={task.enabled ? t("card.disabled") : t("card.enabled")}
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

function LastRun({ status, time }: { status: string | null; time: string }) {
  const { t } = useTranslation(NS.TASKS_V2);
  const Icon =
    status === "success" ? CheckCircle2 : status === "failed" ? XCircle : status === "timeout" ? Clock : MinusCircle;
  return (
    <span className={`task-last-run is-${status ?? "pending"}`}>
      <Icon />
      <span>
        {status ? t(`status.${status}`) : t("status.pending")}
        <small>{time}</small>
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
    <Input
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
