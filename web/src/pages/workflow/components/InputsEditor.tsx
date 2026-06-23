import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function InputsEditor({
  value,
  onChange,
  readOnly,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  value: Record<string, string> | undefined;
  onChange: (val: Record<string, string> | undefined) => void;
  readOnly: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  const { t } = useTranslation("workflows");
  const entries = Object.entries(value ?? {});
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusKeyIdx, setFocusKeyIdx] = useState<number | null>(null);

  const entriesLen = entries.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only reset when entry count changes
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

  const updateEntry = (index: number, field: "key" | "value", newValue: string) => {
    const updated = { ...value };
    const oldKey = entries[index][0];
    if (field === "key") {
      delete updated[oldKey];
      updated[newValue] = entries[index][1];
    } else {
      updated[oldKey] = newValue;
    }
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
    const updated = { ...value, "": "" };
    onChange(updated);
    setFocusKeyIdx(Object.keys(updated).length - 1);
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number, field: "key" | "value") => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (field !== "value") return;
    const isLastEntry = index === entries.length - 1;
    if (!isLastEntry) return;
    e.preventDefault();
    addEntry();
  };

  const isEmptyKey = (k: string) => k.trim() === "";

  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v], i) => {
        const isConfirming = confirmDeleteKey === k && k !== "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep input focus stable when key is being edited
          <div key={`${k}-${i}`} className="flex items-center gap-1">
            <Input
              value={k}
              onChange={(e) => updateEntry(i, "key", e.target.value)}
              placeholder={keyPlaceholder}
              readOnly={readOnly}
              autoFocus={i === focusKeyIdx}
              className={`h-8 text-xs ${isEmptyKey(k) ? "border-red-300 bg-red-50" : ""}`}
              style={{ width: "30%" }}
            />
            <Input
              value={v}
              onChange={(e) => updateEntry(i, "value", e.target.value)}
              placeholder={valuePlaceholder}
              readOnly={readOnly}
              onKeyDown={(e) => handleKeyDown(e, i, "value")}
              title={t("editor.inputs_enter_to_add")}
              className="flex-1 h-8 text-xs"
            />
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
