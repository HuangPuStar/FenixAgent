import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type OutputType = "file" | "file-list" | "dir" | "value";

export interface OutputEntry {
  pattern: string;
  type: OutputType;
}

/**
 * 输出字段编辑器。
 *
 * 改名行为：key 输入使用本地状态，仅在 blur 且改名时触发 onKeyRename。
 * 父组件可弹出确认框并同步下游引用；用户取消时编辑器回退本地状态，不触发 onChange。
 */
export function OutputsEditor({
  value,
  onChange,
  readOnly,
  keyPlaceholder,
  patternPlaceholder,
  addLabel,
  onKeyRename,
  onBeforeDelete,
}: {
  value: Record<string, OutputEntry> | undefined;
  onChange: (val: Record<string, OutputEntry> | undefined) => void;
  readOnly: boolean;
  keyPlaceholder: string;
  patternPlaceholder: string;
  addLabel: string;
  /** key 改名确认回调。返回 false 表示取消，编辑器回退本地状态。 */
  onKeyRename?: (oldKey: string, newKey: string) => Promise<boolean>;
  /** 删除确认回调。返回 false 表示取消删除。 */
  onBeforeDelete?: (key: string) => Promise<boolean>;
}) {
  const { t } = useTranslation("workflows");
  const entries = Object.entries(value ?? {});
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusKeyIdx, setFocusKeyIdx] = useState<number | null>(null);

  // key 编辑使用本地状态，blur 时才决定是否提交改名
  const [editingKeyIdx, setEditingKeyIdx] = useState<number | null>(null);
  const [editingKeyValue, setEditingKeyValue] = useState("");
  const editSnapshotRef = useRef<string>(""); // focus 时记录的原始 key

  const entriesLen = entries.length;
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

  const commitKeyRename = useCallback(
    async (index: number) => {
      setEditingKeyIdx(null);
      const oldKey = editSnapshotRef.current;
      const newKey = editingKeyValue.replace(/[^a-zA-Z0-9_-]/g, "").trim();
      if (!newKey || newKey === oldKey) return; // 无变化或空值，放弃
      if (onKeyRename) {
        const confirmed = await onKeyRename(oldKey, newKey);
        if (!confirmed) return; // 用户取消，放弃改名
      }
      // 确认通过，提交
      const updated: Record<string, OutputEntry> = {};
      entries.forEach(([k, v], i) => {
        if (i === index) updated[newKey] = v;
        else updated[k] = v;
      });
      onChange(updated);
    },
    [editingKeyValue, entries, onChange, onKeyRename],
  );

  const updateEntry = (index: number, patch: Partial<OutputEntry>) => {
    const updated = { ...value };
    const oldKey = entries[index][0];
    updated[oldKey] = { ...updated[oldKey], ...patch };
    onChange(updated);
  };

  const removeEntry = (index: number) => {
    const updated = { ...value };
    delete updated[entries[index][0]];
    onChange(Object.keys(updated).length === 0 ? undefined : updated);
  };

  const handleDeleteClick = async (index: number) => {
    const entryKey = entries[index][0];
    if (confirmDeleteKey === entryKey) {
      if (entryKey && onBeforeDelete) {
        const confirmed = await onBeforeDelete(entryKey);
        if (!confirmed) {
          setConfirmDeleteKey(null);
          return;
        }
      }
      removeEntry(index);
      setConfirmDeleteKey(null);
    } else {
      setConfirmDeleteKey(entryKey);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDeleteKey(null), 3000);
    }
  };

  const addEntry = () => {
    const updated = { ...(value ?? {}), "": { pattern: "", type: "file" as OutputType } };
    onChange(updated);
    setFocusKeyIdx(Object.keys(updated).length - 1);
  };

  const isEmptyKey = (k: string) => k.trim() === "";

  const isValueType = (t: string) => t === "value";

  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v], i) => {
        const isConfirming = confirmDeleteKey === k && k !== "";
        const isEditing = editingKeyIdx === i;
        const displayKey = isEditing ? editingKeyValue : k;
        return (
          <div key={`${k}-${i}`} className="flex items-center gap-1">
            <Input
              value={displayKey}
              onChange={(e) => {
                if (isEditing) {
                  setEditingKeyValue(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""));
                }
              }}
              placeholder={keyPlaceholder}
              readOnly={readOnly}
              autoFocus={i === focusKeyIdx}
              onFocus={() => {
                if (k.trim()) {
                  setEditingKeyIdx(i);
                  setEditingKeyValue(k);
                  editSnapshotRef.current = k;
                }
              }}
              onBlur={() => {
                if (isEditing) {
                  commitKeyRename(i);
                }
              }}
              className={`h-8 text-xs ${isEmptyKey(displayKey) && !isEditing ? "border-red-300 bg-red-50" : ""}`}
              style={{ width: isValueType(v.type) ? undefined : "28%" }}
            />
            {isValueType(v.type) ? null : (
              <Input
                value={v.pattern}
                onChange={(e) => updateEntry(i, { pattern: e.target.value })}
                placeholder={patternPlaceholder}
                readOnly={readOnly}
                className="flex-1 h-8 text-xs"
              />
            )}
            <Select
              value={v.type}
              onValueChange={(val) => updateEntry(i, { type: val as OutputType })}
              disabled={readOnly}
            >
              <SelectTrigger className="h-8 text-xs w-[84px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="file">file</SelectItem>
                <SelectItem value="file-list">file-list</SelectItem>
                <SelectItem value="dir">dir</SelectItem>
                <SelectItem value="value">{t("outputs_type_value")}</SelectItem>
              </SelectContent>
            </Select>
            {!readOnly && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleDeleteClick(i)}
                title={isConfirming ? t("components:confirm") : undefined}
                className={`size-6 flex-shrink-0 ${isConfirming ? "bg-amber-50 text-red-500" : "text-gray-400"}`}
              >
                <Trash2 size={13} />
              </Button>
            )}
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
