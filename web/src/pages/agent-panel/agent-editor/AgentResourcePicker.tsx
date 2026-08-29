import { Search, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { NS } from "../../../i18n";
import { EditorGroupFilter, EditorPagination } from "./agent-editor-controls";
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
    <div className="agent-resource-picker" role="group" aria-label={label}>
      <div className="agent-resource-picker__selected">
        <div>
          <strong>{t("editor.selectedCount", { count: value.length })}</strong>
          <small>{t("editor.changeSelection")}</small>
        </div>
        <div className="agent-resource-picker__chips">
          {selectedOptions.length ? (
            selectedOptions.map((item) => {
              const unavailableText = item.unavailable
                ? t("editor.selectedUnavailableResource", { name: item.label })
                : undefined;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={item.unavailable ? "is-unavailable" : ""}
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
            <span className="agent-resource-picker__empty">{t("editor.noneSelected")}</span>
          )}
        </div>
      </div>
      <label className="agent-resource-picker__search">
        <Search />
        <input
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
      <div className={`agent-editor-library-picker${showGroups ? "" : " is-flat"}`}>
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
          <div className="agent-resource-picker__list" role="group" aria-label={label}>
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
                  className={`${checked ? "is-selected " : ""}${item.unavailable ? "is-unavailable " : ""}${renderIcon ? "has-icon" : ""}`}
                  key={item.id}
                  htmlFor={checkboxId}
                  title={item.unavailable ? unavailableLabel : undefined}
                >
                  {renderIcon && <span className="agent-resource-picker__icon">{renderIcon(item)}</span>}
                  <span className="agent-resource-picker__copy">
                    <strong>{item.label}</strong>
                    <small>{item.description ?? (item.unavailable ? t("editor.unavailable") : "")}</small>
                  </span>
                  <Checkbox
                    id={checkboxId}
                    checked={checked}
                    disabled={readOnly || (item.unavailable && !checked)}
                    onCheckedChange={() => toggle(item)}
                    aria-label={unavailableLabel}
                  />
                </label>
              );
            })}
            {!filtered.length && <p>{emptyText ?? t("editor.noMatchingResources")}</p>}
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
