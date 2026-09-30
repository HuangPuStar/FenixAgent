import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useTranslation } from "react-i18next";
import type { KeyValueEntry } from "./agent-mcp-utils";

/**
 * 键值行的视图模型：稳定 id 避免删除时错配 DOM 或输入时重挂载。
 * id 不进入 payload，提交转换只读取 key/value。
 */
export type KeyValueRow = KeyValueEntry & { id: string };

let rowSequence = 0;

/** 行 id 只需在列表内唯一，创建后在整个编辑期间保持稳定。 */
export function createKeyValueRow(key = "", value = ""): KeyValueRow {
  rowSequence += 1;
  return { id: `row-${rowSequence}`, key, value };
}

/** 将配置记录转换为编辑行，空配置保留一行可输入控件。 */
export function toEntries(record?: Record<string, unknown>): KeyValueRow[] {
  return record
    ? Object.entries(record).map(([key, value]) => createKeyValueRow(key, String(value)))
    : [createKeyValueRow()];
}

/** 编辑 MCP 环境变量或请求头，保持每个输入行的身份稳定。 */
export function KeyValueEditor({
  label,
  entries,
  disabled,
  onChange,
  namePlaceholder = "KEY",
  valuePlaceholder = "VALUE",
}: {
  label: string;
  entries: KeyValueRow[];
  disabled: boolean;
  onChange: (entries: KeyValueRow[]) => void;
  namePlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const { t } = useTranslation(NS.MCP);
  const update = (index: number, patch: Partial<KeyValueEntry>) =>
    onChange(entries.map((entry, entryIndex) => (entryIndex === index ? { ...entry, ...patch } : entry)));
  return (
    <div>
      {/* 组标题不关联某个独占输入框；保留既有布局与交互，本次只拆分模块归属。 */}
      <div className="mb-2 flex items-center justify-between">
        <label className="text-sm font-medium text-text-primary">{label}</label>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange([...entries, createKeyValueRow()])}
        >
          {t("btn.add")}
        </Button>
      </div>
      <div className="space-y-2">
        {entries.map((entry, index) => (
          <div className="flex items-center gap-2" key={entry.id}>
            <Input
              value={entry.key}
              placeholder={namePlaceholder}
              disabled={disabled}
              onChange={(event) => update(index, { key: event.target.value })}
            />
            <Input
              value={entry.value}
              placeholder={valuePlaceholder}
              disabled={disabled}
              onChange={(event) => update(index, { value: event.target.value })}
            />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(entries.filter((_, entryIndex) => entryIndex !== index))}
            >
              {t("btn.delete")}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
