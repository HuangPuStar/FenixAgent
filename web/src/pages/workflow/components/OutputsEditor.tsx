import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
  const keyRefs = useRef<(HTMLInputElement | null)[]>([]);

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
    requestAnimationFrame(() => {
      const lastIdx = Object.keys(updated).length - 1;
      keyRefs.current[lastIdx]?.focus();
    });
  };

  return (
    <div>
      {entries.map(([k, v], i) => {
        const isConfirming = confirmDeleteKey === k && k !== "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep focus stable while editing key
          <div key={`${k}-${i}`} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
            <input
              ref={(el) => {
                keyRefs.current[i] = el;
              }}
              value={k}
              onChange={(e) => updateKey(i, e.target.value)}
              placeholder={keyPlaceholder}
              readOnly={readOnly}
              style={{
                width: "28%",
                ...(k.trim() === "" ? { borderColor: "#fca5a5", background: "#fef2f2" } : {}),
              }}
            />
            <input
              value={v.pattern}
              onChange={(e) => updateEntry(i, { pattern: e.target.value })}
              placeholder={patternPlaceholder}
              readOnly={readOnly}
              style={{ flex: 1 }}
            />
            <select
              value={v.type}
              onChange={(e) => updateEntry(i, { type: e.target.value as OutputType })}
              disabled={readOnly}
              style={{ width: 84 }}
            >
              <option value="file">file</option>
              <option value="file-list">file-list</option>
              <option value="dir">dir</option>
            </select>
            {!readOnly && (
              <button
                type="button"
                onClick={() => handleDeleteClick(i)}
                title={isConfirming ? t("components:confirm") : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 24,
                  height: 24,
                  border: "none",
                  background: isConfirming ? "#fef2c7" : "none",
                  color: isConfirming ? "#ef4444" : "#9ca3af",
                  cursor: "pointer",
                  borderRadius: 4,
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        );
      })}
      {!readOnly && (
        <button
          type="button"
          onClick={addEntry}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            border: "none",
            background: "none",
            color: "#6b7280",
            cursor: "pointer",
            fontSize: 11,
            padding: 0,
          }}
        >
          <Plus size={12} /> {addLabel}
        </button>
      )}
    </div>
  );
}
