import { Check, ChevronLeft, ChevronRight, Cpu, Minus, Plus, Search } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";
import { type AgentEditorOption, filterAgentEditorOptions, paginateAgentEditorOptions } from "./agent-editor-model";

export function Intro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className="agent-editor-section__intro">
      <span>{eyebrow}</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </header>
  );
}

export function EditorField({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`agent-editor-field${className ? ` ${className}` : ""}`}>
      <span className="agent-editor-field__label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

export function EditorInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`agent-editor-input${props.className ? ` ${props.className}` : ""}`} />;
}

export function EditorTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`agent-editor-textarea${props.className ? ` ${props.className}` : ""}`} />;
}

export function EditorButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={`agent-editor-button${props.className ? ` ${props.className}` : ""}`} />;
}

export function EditorStepperField({
  value,
  onChange,
  min,
  max,
  disabled,
  decreaseLabel,
  increaseLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  disabled: boolean;
  decreaseLabel: string;
  increaseLabel: string;
}) {
  const update = (next: number) => onChange(Math.min(max, Math.max(min, next)));
  return (
    <div className="agent-editor-stepper">
      <button
        type="button"
        onClick={() => update(value - 1)}
        disabled={disabled || value <= min}
        aria-label={decreaseLabel}
      >
        <Minus />
      </button>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => update(event.currentTarget.valueAsNumber || min)}
      />
      <button
        type="button"
        onClick={() => update(value + 1)}
        disabled={disabled || value >= max}
        aria-label={increaseLabel}
      >
        <Plus />
      </button>
    </div>
  );
}

export const Field = EditorField;

export function Toggle({
  checked,
  onChange,
  icon,
  title,
  description,
  badge,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  icon: ReactNode;
  title: string;
  description: string;
  badge?: string;
  disabled: boolean;
}) {
  return (
    <button
      className={`agent-editor-toggle-row${checked ? " is-on" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="agent-editor-toggle-row__icon">{icon}</span>
      <span className="agent-editor-toggle-row__copy">
        <strong>
          {title}
          {badge && <em>{badge}</em>}
        </strong>
        <small>{description}</small>
      </span>
      <span className="agent-editor-switch" aria-hidden="true">
        <i />
      </span>
    </button>
  );
}

export function EditorPagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (value: number) => void;
}) {
  const { t } = useTranslation(NS.AGENTS);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  if (total === 0 || pageCount === 1) return null;
  return (
    <footer className="agent-editor-pagination">
      <span>
        {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, total)} / {total}
      </span>
      <div>
        <button
          type="button"
          disabled={safePage === 0}
          onClick={() => onPageChange(safePage - 1)}
          aria-label={t("editor.previousPage")}
        >
          <ChevronLeft />
        </button>
        <strong>
          {safePage + 1} / {pageCount}
        </strong>
        <button
          type="button"
          disabled={safePage + 1 >= pageCount}
          onClick={() => onPageChange(safePage + 1)}
          aria-label={t("editor.nextPage")}
        >
          <ChevronRight />
        </button>
      </div>
    </footer>
  );
}

export function EditorGroupFilter({
  options,
  value,
  onChange,
  hideAll = false,
}: {
  options: AgentEditorOption[];
  value: string;
  onChange: (value: string) => void;
  hideAll?: boolean;
}) {
  const { t } = useTranslation(NS.AGENTS);
  const groups = Array.from(
    options.reduce((result, option) => {
      const group =
        option.group ?? (option.unavailable ? { id: "unavailable", label: t("editor.unavailableBindings") } : null);
      if (!group) return result;
      const current = result.get(group.id);
      result.set(group.id, { ...group, count: (current?.count ?? 0) + 1 });
      return result;
    }, new Map<string, { id: string; label: string; scope?: "organization" | "shared"; count: number }>()),
  ).map(([, group]) => group);
  if (groups.length === 0) return null;
  return (
    <nav className="agent-editor-group-filter" aria-label={t("editor.resourceSources")}>
      {!hideAll && (
        <button type="button" className={value === "all" ? "is-active" : ""} onClick={() => onChange("all")}>
          <span>{t("editor.allSources")}</span>
          <em>{options.length}</em>
        </button>
      )}
      {groups.map((group) => (
        <button
          type="button"
          key={group.id}
          className={value === group.id ? "is-active" : ""}
          onClick={() => onChange(group.id)}
        >
          <span>{group.label}</span>
          <em>{group.count}</em>
        </button>
      ))}
    </nav>
  );
}

export function SinglePicker({
  options,
  value,
  onChange,
  label,
  icon: Icon,
  disabled,
  requireGroup = false,
  renderIcon,
}: {
  options: AgentEditorOption[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  icon: typeof Cpu;
  disabled: boolean;
  requireGroup?: boolean;
  renderIcon?: (item: AgentEditorOption) => ReactNode;
}) {
  const { t } = useTranslation(NS.AGENTS);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [page, setPage] = useState(0);
  const size = 6;
  const showGroups = options.some((item) => item.group);
  const selected = options.find((item) => item.id === value);
  const defaultGroup = selected?.group?.id ?? options.find((item) => item.group)?.group?.id ?? "all";
  const requestedGroup = requireGroup && group === "all" ? defaultGroup : group;
  const firstPass = filterAgentEditorOptions(options, query, requestedGroup);
  const fallbackGroup = requireGroup ? firstPass.matching.find((item) => item.group)?.group?.id : undefined;
  const filtered =
    requireGroup && firstPass.activeGroup === "all" && fallbackGroup
      ? filterAgentEditorOptions(options, query, fallbackGroup)
      : firstPass;
  const { matching, visible, activeGroup } = filtered;
  const paged = paginateAgentEditorOptions(visible, page, size);
  const listClass = Icon === Cpu ? "agent-model-options" : "agent-node-list";
  return (
    <>
      <div className="agent-single-picker-toolbar">
        <label>
          <Search />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            placeholder={t("editor.searchPlaceholder", { resource: label })}
          />
        </label>
        <span>{t("editor.optionCount", { count: visible.length })}</span>
      </div>
      {selected && (
        <div className={`agent-single-picker-current${selected.unavailable ? " is-unavailable" : ""}`}>
          <small>{t("editor.currentSelection")}</small>
          <strong>{selected.label}</strong>
          <span>
            {selected.description}
            {selected.unavailable && ` · ${t("editor.unavailable")}`}
          </span>
        </div>
      )}
      <div className={`agent-editor-library-picker${showGroups ? "" : " is-flat"}`}>
        {showGroups && (
          <EditorGroupFilter
            options={matching}
            value={activeGroup}
            hideAll={requireGroup}
            onChange={(next) => {
              setGroup(next);
              setPage(0);
            }}
          />
        )}
        <div className="agent-editor-library-picker__results">
          <div className={listClass} role="radiogroup" aria-label={label}>
            {paged.items.map((item) => (
              <button
                className={`${item.id === value ? "is-selected " : ""}${item.unavailable ? "is-unavailable" : ""}`}
                type="button"
                role="radio"
                aria-checked={item.id === value}
                aria-label={
                  item.unavailable
                    ? item.id === value
                      ? t("editor.selectedUnavailableResource", { name: item.label })
                      : t("editor.unavailableResource", { name: item.label })
                    : undefined
                }
                title={
                  item.unavailable
                    ? item.id === value
                      ? t("editor.selectedUnavailableResource", { name: item.label })
                      : t("editor.unavailableResource", { name: item.label })
                    : undefined
                }
                disabled={disabled || item.unavailable}
                key={item.id}
                onClick={() => {
                  setGroup(item.group?.id ?? activeGroup);
                  onChange(item.id);
                }}
              >
                <span className="agent-model-options__icon">{renderIcon ? renderIcon(item) : <Icon />}</span>
                <span className="agent-model-options__copy">
                  <strong>{item.label}</strong>
                  <small>{item.description ?? (item.unavailable ? t("editor.unavailable") : "")}</small>
                </span>
                <i>{item.id === value && <Check />}</i>
              </button>
            ))}
          </div>
          <EditorPagination page={page} total={visible.length} pageSize={size} onPageChange={setPage} />
        </div>
      </div>
    </>
  );
}

export const ToggleField = Toggle;
export const JsonField = EditorTextarea;
