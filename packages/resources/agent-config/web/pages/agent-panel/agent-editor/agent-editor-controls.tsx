import { cn } from "@fenix/ui-components/lib/cn";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Check, ChevronLeft, ChevronRight, Cpu, Minus, Plus, Search } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { SECTION_INTRO } from "./agent-editor-classes";
import "./agent-editor-controls.css";
import {
  BUTTON,
  FIELD,
  FIELD_LABEL,
  GROUP_FILTER_NARROW,
  INPUT,
  LIBRARY_PICKER_NARROW,
  MODEL_OPTIONS,
  NODE_LIST,
  OPTION_CHECK,
  OPTION_CHECK_SELECTED,
  OPTION_COPY,
  OPTION_COPY_HINT_UNAVAILABLE,
  OPTION_ICON,
  OPTION_ROW,
  OPTION_ROW_SELECTED,
  OPTION_ROW_SELECTED_DISABLED,
  OPTION_ROW_UNAVAILABLE,
  PAGINATION,
  PAGINATION_BUTTON,
  PAGINATION_COUNT,
  PAGINATION_GROUP,
  PICKER_INPUT,
  SINGLE_PICKER_CURRENT,
  SINGLE_PICKER_CURRENT_UNAVAILABLE,
  SINGLE_PICKER_TOOLBAR,
  STEPPER,
  STEPPER_BUTTON,
  STEPPER_CONTROL,
  TEXTAREA,
  TOGGLE_COPY,
  TOGGLE_ICON,
  TOGGLE_KNOB,
  TOGGLE_ROW,
  TOGGLE_SWITCH,
} from "./agent-editor-form-classes";
import {
  GROUP_FILTER,
  GROUP_FILTER_BUTTON,
  GROUP_FILTER_BUTTON_ACTIVE,
  GROUP_FILTER_COUNT,
  GROUP_FILTER_LABEL,
  LIBRARY_PICKER,
  LIBRARY_PICKER_FLAT,
  LIBRARY_PICKER_RESULTS,
  PAGINATION_IN_RESULTS,
} from "./agent-editor-library-classes";
import { type AgentEditorOption, filterAgentEditorOptions, paginateAgentEditorOptions } from "./agent-editor-model";

/**
 * 分区说明块：眉标 8px/750/等宽 + 标题 18px（760–1399 压 16px）+ 说明 12px（760–1119 收窄到 52ch）。
 * `> span` / `> h3` / `> p` 与两段窄屏覆盖见 `agent-editor-controls.css`（与 A2 的 `SECTION_INTRO` 同名同类）。
 */
const INTRO = `${SECTION_INTRO} agent-editor-section__intro`;
/** 模型列表（`agent-model-options`）的校验态：focus ring 之外再描一圈红（源为 `[aria-invalid="true"]` 规则）。 */
const MODEL_OPTIONS_INVALID =
  "aria-invalid:rounded-lg aria-invalid:outline-2 aria-invalid:outline-offset-3 " +
  "aria-invalid:outline-[color-mix(in_srgb,var(--color-destructive,#dc2626)_45%,transparent)]";

export function Intro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className={INTRO} data-slot="editor-section-intro">
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
    <label className={cn(FIELD, className)}>
      <span className={FIELD_LABEL} data-slot="editor-field-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

export function EditorInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(INPUT, props.className)} />;
}

export function EditorTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn(TEXTAREA, props.className)} />;
}

export function EditorButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={cn(BUTTON, props.className)} />;
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
    <div className={STEPPER}>
      <button
        type="button"
        className={cn(STEPPER_CONTROL, STEPPER_BUTTON)}
        onClick={() => update(value - 1)}
        disabled={disabled || value <= min}
        aria-label={decreaseLabel}
      >
        <Minus />
      </button>
      <input
        className={STEPPER_CONTROL}
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => update(event.currentTarget.valueAsNumber || min)}
      />
      <button
        type="button"
        className={cn(STEPPER_CONTROL, STEPPER_BUTTON)}
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
      className={TOGGLE_ROW}
      data-state={checked ? "on" : "off"}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className={TOGGLE_ICON}>{icon}</span>
      <span className={TOGGLE_COPY}>
        <strong>
          {title}
          {badge && <em>{badge}</em>}
        </strong>
        <small>{description}</small>
      </span>
      <span className={TOGGLE_SWITCH} aria-hidden="true">
        <i className={TOGGLE_KNOB} />
      </span>
    </button>
  );
}

export function EditorPagination({
  page,
  pageSize,
  total,
  onPageChange,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (value: number) => void;
  /** 调用点补充分页条样式（如结果区贴底 / 内嵌形态收边距）。 */
  className?: string;
}) {
  const { t } = useTranslation(NS.AGENTS);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  if (total === 0 || pageCount === 1) return null;
  return (
    <footer className={cn(PAGINATION, className)} data-slot="pagination">
      <span>
        {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, total)} / {total}
      </span>
      <div className={PAGINATION_GROUP}>
        <button
          type="button"
          className={PAGINATION_BUTTON}
          disabled={safePage === 0}
          onClick={() => onPageChange(safePage - 1)}
          aria-label={t("editor.previousPage")}
        >
          <ChevronLeft />
        </button>
        <strong className={PAGINATION_COUNT}>
          {safePage + 1} / {pageCount}
        </strong>
        <button
          type="button"
          className={PAGINATION_BUTTON}
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
    <nav
      className={cn(GROUP_FILTER, GROUP_FILTER_NARROW)}
      data-slot="group-filter"
      aria-label={t("editor.resourceSources")}
    >
      {!hideAll && (
        <button
          type="button"
          className={cn(GROUP_FILTER_BUTTON, value === "all" && GROUP_FILTER_BUTTON_ACTIVE)}
          data-active={value === "all" ? "true" : undefined}
          onClick={() => onChange("all")}
        >
          <span className={GROUP_FILTER_LABEL}>{t("editor.allSources")}</span>
          <em className={GROUP_FILTER_COUNT}>{options.length}</em>
        </button>
      )}
      {groups.map((group) => (
        <button
          type="button"
          key={group.id}
          className={cn(GROUP_FILTER_BUTTON, value === group.id && GROUP_FILTER_BUTTON_ACTIVE)}
          data-active={value === group.id ? "true" : undefined}
          onClick={() => onChange(group.id)}
        >
          <span className={GROUP_FILTER_LABEL}>{group.label}</span>
          <em className={GROUP_FILTER_COUNT}>{group.count}</em>
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
  invalid = false,
  errorMessage,
  requireGroup = false,
  renderIcon,
}: {
  options: AgentEditorOption[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  icon: typeof Cpu;
  disabled: boolean;
  invalid?: boolean;
  errorMessage?: string;
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
  const listClass = Icon === Cpu ? cn(MODEL_OPTIONS, MODEL_OPTIONS_INVALID) : NODE_LIST;
  return (
    <>
      <div className={SINGLE_PICKER_TOOLBAR}>
        <label>
          <Search />
          <input
            className={PICKER_INPUT}
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
        <div className={cn(SINGLE_PICKER_CURRENT, selected.unavailable && SINGLE_PICKER_CURRENT_UNAVAILABLE)}>
          <small>{t("editor.currentSelection")}</small>
          <strong>{selected.label}</strong>
          <span>
            {selected.description}
            {selected.unavailable && ` · ${t("editor.unavailable")}`}
          </span>
        </div>
      )}
      <div
        className={cn(LIBRARY_PICKER, LIBRARY_PICKER_NARROW, !showGroups && LIBRARY_PICKER_FLAT)}
        data-slot="library-picker"
        data-flat={!showGroups ? "true" : undefined}
      >
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
        <div className={LIBRARY_PICKER_RESULTS}>
          <div
            id={Icon === Cpu ? "agent-editor-model-options" : undefined}
            className={listClass}
            role="radiogroup"
            tabIndex={-1}
            aria-label={label}
            aria-invalid={invalid}
            aria-describedby={invalid && errorMessage ? "agent-editor-model-error" : undefined}
          >
            {paged.items.map((item) => (
              <button
                className={cn(
                  OPTION_ROW,
                  Icon === Cpu ? "agent-editor-option-row--model" : "agent-editor-option-row--node",
                  item.id === value && OPTION_ROW_SELECTED,
                  item.unavailable && OPTION_ROW_UNAVAILABLE,
                  item.id === value && (disabled || item.unavailable) && OPTION_ROW_SELECTED_DISABLED,
                )}
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
                <span className={OPTION_ICON}>{renderIcon ? renderIcon(item) : <Icon />}</span>
                <span className={OPTION_COPY}>
                  <strong>{item.label}</strong>
                  <small className={item.unavailable ? OPTION_COPY_HINT_UNAVAILABLE : undefined}>
                    {item.description ?? (item.unavailable ? t("editor.unavailable") : "")}
                  </small>
                </span>
                <i className={cn(OPTION_CHECK, item.id === value && OPTION_CHECK_SELECTED)}>
                  {item.id === value && <Check />}
                </i>
              </button>
            ))}
          </div>
          {invalid && errorMessage && (
            <p id="agent-editor-model-error" className="mt-2 text-3xs text-destructive" role="alert">
              {errorMessage}
            </p>
          )}
          <EditorPagination
            page={page}
            total={visible.length}
            pageSize={size}
            onPageChange={setPage}
            className={PAGINATION_IN_RESULTS}
          />
        </div>
      </div>
    </>
  );
}

export const ToggleField = Toggle;
export const JsonField = EditorTextarea;
