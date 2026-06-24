import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type OutputType = "file" | "file-list" | "dir";

export interface OutputEntry {
  pattern: string;
  type: OutputType;
}

export function OutputsEditor({
  value,
  onChange,
  readOnly,
  keyPlaceholder,
  patternPlaceholder,
  addLabel,
}: {
  value: Record<string, OutputEntry> | undefined;
  onChange: (val: Record<string, OutputEntry> | undefined) => void;
  readOnly: boolean;
  keyPlaceholder: string;
  patternPlaceholder: string;
  addLabel: string;
}) {
  const { t } = useTranslation("workflows");
  const entries = Object.entries(value ?? {});
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusKeyIdx, setFocusKeyIdx] = useState<number | null>(null);

  const entriesLen = entries.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when entry count changes
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
    const updated: Record<string, OutputEntry> = {};
    entries.forEach(([k, v], i) => {
      if (i === index) updated[newKey] = v;
      else updated[k] = v;
    });
    onChange(updated);
  };

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
    const updated = { ...(value ?? {}), "": { pattern: "", type: "file" as OutputType } };
    onChange(updated);
    setFocusKeyIdx(Object.keys(updated).length - 1);
  };

  const isEmptyKey = (k: string) => k.trim() === "";

  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v], i) => {
        const isConfirming = confirmDeleteKey === k && k !== "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep focus stable while editing key
          <div key={`${k}-${i}`} className="flex items-center gap-1">
            <Input
              value={k}
              onChange={(e) => updateKey(i, e.target.value)}
              placeholder={keyPlaceholder}
              readOnly={readOnly}
              autoFocus={i === focusKeyIdx}
              className={`h-8 text-xs ${isEmptyKey(k) ? "border-red-300 bg-red-50" : ""}`}
              style={{ width: "28%" }}
            />
            <Input
              value={v.pattern}
              onChange={(e) => updateEntry(i, { pattern: e.target.value })}
              placeholder={patternPlaceholder}
              readOnly={readOnly}
              className="flex-1 h-8 text-xs"
            />
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
