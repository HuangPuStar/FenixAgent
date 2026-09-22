import { cn } from "@fenix/ui-components/lib/cn";
import { Checkbox } from "@fenix/ui-components/ui/checkbox";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Search, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditorGroupFilter, EditorPagination } from "./agent-editor-controls";
import {
  PICKER,
  PICKER_CHECKBOX,
  PICKER_CHECKBOX_CHECKED,
  PICKER_CHIP_UNAVAILABLE,
  PICKER_CHIPS,
  PICKER_COPY,
  PICKER_EMPTY,
  PICKER_ICON,
  PICKER_INPUT,
  PICKER_LIST,
  PICKER_LIST_EMPTY,
  PICKER_ROW,
  PICKER_ROW_HINT,
  PICKER_ROW_SELECTED,
  PICKER_ROW_SELECTED_DISABLED,
  PICKER_ROW_TITLE,
  PICKER_ROW_UNAVAILABLE,
  PICKER_ROW_WITH_ICON,
  PICKER_SEARCH,
  PICKER_SELECTED,
} from "./agent-editor-form-classes";
import {
  AGENT_EDITOR_PAGE_SIZE,
  type AgentEditorOption,
  filterAgentEditorOptions,
  paginateAgentEditorOptions,
} from "./agent-editor-model";

interface AgentResourcePickerProps {
  options: AgentEditorOption[];
  value: string[];
  onChange: (value: string[]) => void;
  label: string;
  multiple?: boolean;
  readOnly?: boolean;
  emptyText?: string;
  groupMode?: "required" | "auto" | "none";
  renderIcon?: (item: AgentEditorOption) => ReactNode;
}

export function AgentResourcePicker({
  options,
  value,
  onChange,
  label,
  multiple = true,
  readOnly = false,
  emptyText,
  groupMode = "none",
  renderIcon,
}: AgentResourcePickerProps) {
  const { t } = useTranslation(NS.AGENTS);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [page, setPage] = useState(0);
  const selected = useMemo(() => new Set(value), [value]);
  const groupIds = new Set(options.map((item) => item.group?.id).filter(Boolean));
  const showGroups = groupMode === "required" || (groupMode === "auto" && groupIds.size > 1);
  const defaultGroup =
    options.find((item) => selected.has(item.id) && item.group)?.group?.id ??
    options.find((item) => item.group)?.group?.id ??
    "all";
  const requestedGroup = showGroups && group === "all" ? defaultGroup : group;
  const firstPass = useMemo(
    () => filterAgentEditorOptions(options, query, requestedGroup),
    [options, query, requestedGroup],
  );
  const fallbackGroup = showGroups ? firstPass.matching.find((item) => item.group)?.group?.id : undefined;
  const filteredOptions =
    showGroups && firstPass.activeGroup === "all" && fallbackGroup
      ? filterAgentEditorOptions(options, query, fallbackGroup)
      : firstPass;
  const matching = filteredOptions.matching;
  const filtered = useMemo(
    () =>
      matching.filter(
        (item) =>
          filteredOptions.activeGroup === "all" ||
          item.group?.id === filteredOptions.activeGroup ||
          (filteredOptions.activeGroup === "unavailable" && item.unavailable),
      ),
    [filteredOptions.activeGroup, matching],
  );
  const activeGroup = filteredOptions.activeGroup;
  const paged = paginateAgentEditorOptions(filtered, page);
  const selectedOptions = value.map(
    (id) => options.find((item) => item.id === id) ?? { id, label: id, unavailable: true },
  );
  const toggle = (item: AgentEditorOption) => {
    const exists = selected.has(item.id);
    if (item.unavailable && !exists) return;
    if (!multiple) return onChange([item.id]);
    onChange(exists ? value.filter((id) => id !== item.id) : [...value, item.id]);
  };
  return (
    <div className={PICKER} role="group" aria-label={label}>
      <div className={PICKER_SELECTED}>
        <div>
          <strong>{t("editor.selectedCount", { count: value.length })}</strong>
          <small>{t("editor.changeSelection")}</small>
        </div>
        <div className={PICKER_CHIPS} data-slot="picker-chips">
          {selectedOptions.length ? (
            selectedOptions.map((item) => {
              const unavailableText = item.unavailable
                ? t("editor.selectedUnavailableResource", { name: item.label })
                : undefined;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={item.unavailable ? PICKER_CHIP_UNAVAILABLE : undefined}
                  data-unavailable={item.unavailable ? "true" : undefined}
                  onClick={() => toggle(item)}
                  disabled={readOnly}
                  aria-label={
                    item.unavailable
                      ? t("editor.removeUnavailableResource", { name: item.label })
                      : t("editor.removeResource", { name: item.label })
                  }
                  title={unavailableText}
                >
                  {item.label}
                  {item.unavailable && <span className="sr-only">{t("editor.unavailable")}</span>}
                  <X />
                </button>
              );
            })
          ) : (
            <span className={PICKER_EMPTY}>{t("editor.noneSelected")}</span>
          )}
        </div>
      </div>
      <label className={PICKER_SEARCH}>
        <Search />
        <input
          className={PICKER_INPUT}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          placeholder={t("editor.searchPlaceholder", { resource: label })}
          aria-label={t("editor.searchPlaceholder", { resource: label })}
        />
        <kbd>{filtered.length.toLocaleString()}</kbd>
      </label>
      <div className={cn("agent-editor-library-picker", !showGroups && "is-flat")}>
        {showGroups && (
          <EditorGroupFilter
            options={matching}
            value={activeGroup}
            hideAll
            onChange={(next) => {
              setGroup(next);
              setPage(0);
            }}
          />
        )}
        <div className="agent-editor-library-picker__results">
          <div className={PICKER_LIST} data-slot="picker-list" role="group" aria-label={label}>
            {paged.items.map((item) => {
              const checked = selected.has(item.id);
              const checkboxId = `agent-resource-${item.id}`;
              const unavailableLabel = item.unavailable
                ? checked
                  ? t("editor.removeUnavailableResource", { name: item.label })
                  : t("editor.unavailableResource", { name: item.label })
                : item.label;
              return (
                <label
                  className={cn(
                    PICKER_ROW,
                    renderIcon && PICKER_ROW_WITH_ICON,
                    checked && PICKER_ROW_SELECTED,
                    item.unavailable && PICKER_ROW_UNAVAILABLE,
                    checked && readOnly && PICKER_ROW_SELECTED_DISABLED,
                  )}
                  key={item.id}
                  htmlFor={checkboxId}
                  title={item.unavailable ? unavailableLabel : undefined}
                >
                  {renderIcon && <span className={PICKER_ICON}>{renderIcon(item)}</span>}
                  <span className={PICKER_COPY}>
                    <strong className={PICKER_ROW_TITLE}>{item.label}</strong>
                    <small className={PICKER_ROW_HINT}>
                      {item.description ?? (item.unavailable ? t("editor.unavailable") : "")}
                    </small>
                  </span>
                  <Checkbox
                    className={cn(PICKER_CHECKBOX, checked && PICKER_CHECKBOX_CHECKED)}
                    id={checkboxId}
                    checked={checked}
                    disabled={readOnly || (item.unavailable && !checked)}
                    onCheckedChange={() => toggle(item)}
                    aria-label={unavailableLabel}
                  />
                </label>
              );
            })}
            {!filtered.length && <p className={PICKER_LIST_EMPTY}>{emptyText ?? t("editor.noMatchingResources")}</p>}
          </div>
          <EditorPagination
            page={paged.page}
            pageSize={AGENT_EDITOR_PAGE_SIZE}
            total={filtered.length}
            onPageChange={setPage}
          />
        </div>
      </div>
    </div>
  );
}
