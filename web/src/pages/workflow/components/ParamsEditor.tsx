import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type ParamType = "string" | "number" | "boolean" | "object";

export interface ParamEntry {
  type?: ParamType;
  default?: unknown;
  required?: boolean;
}

export function ParamsEditor({
  value,
  onChange,
  readOnly,
  namePlaceholder,
  defaultPlaceholder,
  addLabel,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: meta.params 来自用户定义 JSON
  value: Record<string, any> | undefined;
  onChange: (val: Record<string, ParamEntry> | undefined) => void;
  readOnly: boolean;
  namePlaceholder: string;
  defaultPlaceholder: string;
  addLabel: string;
}) {
  const { t } = useTranslation("workflows");
  const entries = Object.entries(value ?? {});
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [objectDrafts, setObjectDrafts] = useState<Record<number, string>>({});
  const [focusKeyIdx, setFocusKeyIdx] = useState<number | null>(null);

  const entriesLen = entries.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on length change
  useEffect(() => {
    setConfirmDeleteKey(null);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, [entriesLen]);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const updateKey = (index: number, newKey: string) => {
    const updated: Record<string, ParamEntry> = {};
    entries.forEach(([k, v], i) => {
      if (i === index) updated[newKey] = v as ParamEntry;
      else updated[k] = v as ParamEntry;
    });
    onChange(updated);
  };

  const updateEntry = (index: number, patch: Partial<ParamEntry>) => {
    const updated = { ...value };
    const oldKey = entries[index][0];
    updated[oldKey] = { ...(updated[oldKey] as ParamEntry), ...patch };
    onChange(updated);
  };

  const changeType = (index: number, newType: ParamType) => {
    setObjectDrafts((d) => ({ ...d, [index]: "" }));
    updateEntry(index, { type: newType, default: undefined });
  };

  const updateDefault = (index: number, newDefault: unknown) => {
    updateEntry(index, { default: newDefault });
  };

  const handleObjectInput = (index: number, text: string) => {
    setObjectDrafts((d) => ({ ...d, [index]: text }));
    const trimmed = text.trim();
    if (!trimmed) {
      updateDefault(index, undefined);
      return;
    }
    try {
      updateDefault(index, JSON.parse(trimmed));
    } catch {
      // JSON 解析失败时仅保留 draft 文本，不写入 default
    }
  };

  const removeEntry = (index: number) => {
    const updated = { ...value };
    delete updated[entries[index][0]];
    onChange(Object.keys(updated).length === 0 ? undefined : updated);
  };

  const handleDeleteClick = (index: number) => {
    const entryKey = entries[index][0];
    if (confirmDeleteKey === entryKey) {
      removeEntry(index);
      setConfirmDeleteKey(null);
    } else {
      setConfirmDeleteKey(entryKey);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDeleteKey(null), 3000);
    }
  };

  const addEntry = () => {
    const updated = {
      ...(value ?? {}),
      "": { type: "string" as ParamType, default: undefined, required: false },
    };
    onChange(updated);
    setFocusKeyIdx(Object.keys(updated).length - 1);
  };

  const isEmptyKey = (k: string) => k.trim() === "";

  const renderDefaultControl = (index: number, entry: ParamEntry) => {
    const type = entry.type ?? "string";
    if (type === "boolean") {
      return (
        <div className="flex items-center h-9 px-2">
          <Checkbox
            checked={entry.default === true}
            onCheckedChange={(checked) => updateDefault(index, !!checked)}
            disabled={readOnly}
          />
        </div>
      );
    }
    if (type === "number") {
      return (
        <Input
          type="number"
          value={entry.default != null ? String(entry.default) : ""}
          onChange={(e) => updateDefault(index, e.target.value ? Number(e.target.value) : undefined)}
          placeholder={defaultPlaceholder}
          readOnly={readOnly}
          className="flex-1 h-8 text-xs"
        />
      );
    }
    if (type === "object") {
      const draft = objectDrafts[index];
      const text = draft !== undefined ? draft : entry.default != null ? JSON.stringify(entry.default) : "";
      const isInvalid = (() => {
        if (draft === undefined || draft.trim() === "") return false;
        try {
          JSON.parse(draft);
          return false;
        } catch {
          return true;
        }
      })();
      return (
        <Textarea
          value={text}
          onChange={(e) => handleObjectInput(index, e.target.value)}
          placeholder='{"key": "value"}'
          rows={2}
          readOnly={readOnly}
          className={`flex-1 text-xs font-mono min-h-0 py-1 ${isInvalid ? "border-red-300 bg-red-50" : ""}`}
        />
      );
    }
    // string
    return (
      <Input
        value={entry.default != null ? String(entry.default) : ""}
        onChange={(e) => updateDefault(index, e.target.value || undefined)}
        placeholder={defaultPlaceholder}
        readOnly={readOnly}
        className="flex-1 h-8 text-xs"
      />
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      {entries.map(([k, v], i) => {
        const entry = v as ParamEntry;
        const isConfirming = confirmDeleteKey === k && k !== "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep focus stable
          <div key={`${k}-${i}`}>
            {/* 第一行：参数名 + 类型 + 必填 + 删除 */}
            <div className="flex items-center gap-1.5">
              <Input
                value={k}
                onChange={(e) => updateKey(i, e.target.value)}
                placeholder={namePlaceholder}
                readOnly={readOnly}
                autoFocus={i === focusKeyIdx}
                className={`h-8 text-xs ${isEmptyKey(k) ? "border-red-300 bg-red-50" : ""}`}
                style={{ width: "28%" }}
              />
              <Select
                value={entry.type ?? "string"}
                onValueChange={(v) => changeType(i, v as ParamType)}
                disabled={readOnly}
              >
                <SelectTrigger className="h-8 text-xs w-[84px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">string</SelectItem>
                  <SelectItem value="number">number</SelectItem>
                  <SelectItem value="boolean">boolean</SelectItem>
                  <SelectItem value="object">object</SelectItem>
                </SelectContent>
              </Select>
              <label className="flex items-center gap-1 text-[10px] text-gray-500 w-16 cursor-pointer">
                <Checkbox
                  checked={entry.required === true}
                  onCheckedChange={(checked) => updateEntry(i, { required: !!checked })}
                  disabled={readOnly}
                />
                {t("editor.params_required_label")}
              </label>
              {!readOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDeleteClick(i)}
                  title={isConfirming ? t("components:confirm") : undefined}
                  className={`size-6 ${isConfirming ? "bg-amber-50 text-red-500" : "text-gray-400"}`}
                >
                  <Trash2 size={13} />
                </Button>
              )}
            </div>
            {/* 第二行：默认值 */}
            <div className="flex gap-1.5 mt-1 items-start">
              <span className="text-[10px] text-gray-400 text-right leading-8" style={{ width: "28%" }}>
                {t("editor.params_default_label")}
              </span>
              <div className="flex-1 flex">{renderDefaultControl(i, entry)}</div>
              {/* spacer for delete button width */}
              {!readOnly && <div className="size-6 flex-shrink-0" />}
            </div>
          </div>
        );
      })}
      {!readOnly && (
        <Button type="button" variant="ghost" size="sm" onClick={addEntry} className="gap-1 text-gray-500 text-xs h-7">
          <Plus size={12} /> {addLabel}
        </Button>
      )}
    </div>
  );
}
