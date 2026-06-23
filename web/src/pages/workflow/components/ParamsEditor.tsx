import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
  const keyRefs = useRef<(HTMLInputElement | null)[]>([]);
  // object 类型的 textarea 单独维护输入文本，JSON 解析失败时不写入
  const [objectDrafts, setObjectDrafts] = useState<Record<number, string>>({});

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

  // type 切换时清空 default，避免类型不匹配（如 number 切换到 object 留下数字）
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
    requestAnimationFrame(() => {
      const lastIdx = Object.keys(updated).length - 1;
      keyRefs.current[lastIdx]?.focus();
    });
  };

  const renderDefaultControl = (index: number, entry: ParamEntry) => {
    const type = entry.type ?? "string";
    if (type === "boolean") {
      return (
        <input
          type="checkbox"
          checked={entry.default === true}
          onChange={(e) => updateDefault(index, e.target.checked)}
          disabled={readOnly}
        />
      );
    }
    if (type === "number") {
      return (
        <input
          type="number"
          value={entry.default != null ? String(entry.default) : ""}
          onChange={(e) => updateDefault(index, e.target.value ? Number(e.target.value) : undefined)}
          placeholder={defaultPlaceholder}
          readOnly={readOnly}
          style={{ flex: 1 }}
        />
      );
    }
    if (type === "object") {
      const draft = objectDrafts[index];
      const text = draft !== undefined ? draft : entry.default != null ? JSON.stringify(entry.default) : "";
      // 提前判断 JSON 是否合法，避免内联复杂三元
      const isInvalid = (() => {
        if (draft === undefined || draft.trim() === "") return false;
        try {
          JSON.parse(draft);
          return false;
        } catch {
          return true;
        }
      })();
      const textareaStyle: React.CSSProperties = {
        flex: 1,
        ...(isInvalid ? { borderColor: "#fca5a5", background: "#fef2f2" } : {}),
      };
      return (
        <textarea
          value={text}
          onChange={(e) => handleObjectInput(index, e.target.value)}
          placeholder='{"key": "value"}'
          rows={2}
          readOnly={readOnly}
          style={textareaStyle}
        />
      );
    }
    // string
    return (
      <input
        type="text"
        value={entry.default != null ? String(entry.default) : ""}
        onChange={(e) => updateDefault(index, e.target.value || undefined)}
        placeholder={defaultPlaceholder}
        readOnly={readOnly}
        style={{ flex: 1 }}
      />
    );
  };

  return (
    <div>
      {entries.map(([k, v], i) => {
        const entry = v as ParamEntry;
        const isConfirming = confirmDeleteKey === k && k !== "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep focus stable
          <div key={`${k}-${i}`} style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                ref={(el) => {
                  keyRefs.current[i] = el;
                }}
                value={k}
                onChange={(e) => updateKey(i, e.target.value)}
                placeholder={namePlaceholder}
                readOnly={readOnly}
                style={{
                  width: "28%",
                  ...(k.trim() === "" ? { borderColor: "#fca5a5", background: "#fef2f2" } : {}),
                }}
              />
              <select
                value={entry.type ?? "string"}
                onChange={(e) => changeType(i, e.target.value as ParamType)}
                disabled={readOnly}
                style={{ width: 84 }}
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="object">object</option>
              </select>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  fontSize: 10,
                  color: "#6b7280",
                  width: 64,
                }}
              >
                <input
                  type="checkbox"
                  checked={entry.required === true}
                  onChange={(e) => updateEntry(i, { required: e.target.checked })}
                  disabled={readOnly}
                />
                {t("editor.params_required_label")}
              </label>
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
            <div style={{ display: "flex", gap: 4, alignItems: "flex-start", marginTop: 2 }}>
              <span style={{ fontSize: 10, color: "#9ca3af", width: "28%", textAlign: "right" }}>
                {t("editor.params_default_label")}
              </span>
              <div style={{ flex: 1, display: "flex" }}>{renderDefaultControl(i, entry)}</div>
            </div>
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
