import { Check, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";
import { EditorPagination } from "./agent-editor-controls";
import { AGENT_EDITOR_PAGE_SIZE, type AgentEditorOption, paginateAgentEditorOptions } from "./agent-editor-model";

interface AgentResourcePickerProps {
  options: AgentEditorOption[];
  value: string[];
  onChange: (value: string[]) => void;
  label: string;
  multiple?: boolean;
  readOnly?: boolean;
  emptyText?: string;
}

export function AgentResourcePicker({
  options,
  value,
  onChange,
  label,
  multiple = true,
  readOnly = false,
  emptyText,
}: AgentResourcePickerProps) {
  const { t } = useTranslation(NS.AGENTS);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const selected = useMemo(() => new Set(value), [value]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return options
      .filter(
        (item) =>
          !needle || `${item.label} ${item.description ?? ""} ${item.meta ?? ""}`.toLocaleLowerCase().includes(needle),
      )
      .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));
  }, [options, query, selected]);
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
      <div className="agent-resource-picker__list" role="listbox" aria-label={label}>
        {paged.items.map((item) => {
          const checked = selected.has(item.id);
          return (
            <button
              className={`${checked ? "is-selected " : ""}${item.unavailable ? "is-unavailable" : ""}`}
              type="button"
              key={item.id}
              role="option"
              aria-selected={checked}
              aria-label={
                item.unavailable
                  ? checked
                    ? t("editor.removeUnavailableResource", { name: item.label })
                    : t("editor.unavailableResource", { name: item.label })
                  : undefined
              }
              title={
                item.unavailable
                  ? checked
                    ? t("editor.selectedUnavailableResource", { name: item.label })
                    : t("editor.unavailableResource", { name: item.label })
                  : undefined
              }
              disabled={readOnly || (item.unavailable && !checked)}
              onClick={() => toggle(item)}
            >
              <span className="agent-resource-picker__check">{checked && <Check />}</span>
              <span>
                <strong>{item.label}</strong>
                <small>{item.description ?? (item.unavailable ? t("editor.unavailable") : "")}</small>
              </span>
              {item.meta && <em>{item.meta}</em>}
            </button>
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
  );
}
