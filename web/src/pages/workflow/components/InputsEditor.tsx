import { Plus, Trash2 } from "lucide-react";

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
  const entries = Object.entries(value ?? {});

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
    if (Object.keys(updated).length === 0) {
      onChange(undefined);
    } else {
      onChange(updated);
    }
  };

  const addEntry = () => {
    const updated = { ...value, "": "" };
    onChange(updated);
  };

  return (
    <div>
      {entries.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep input focus stable when key is being edited
        <div key={`${k}-${i}`} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
          <input
            value={k}
            onChange={(e) => updateEntry(i, "key", e.target.value)}
            placeholder={keyPlaceholder}
            readOnly={readOnly}
            style={{ width: "30%" }}
          />
          <input
            value={v}
            onChange={(e) => updateEntry(i, "value", e.target.value)}
            placeholder={valuePlaceholder}
            readOnly={readOnly}
            style={{ flex: 1 }}
          />
          {!readOnly && (
            <button
              type="button"
              onClick={() => removeEntry(i)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                border: "none",
                background: "none",
                color: "#9ca3af",
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
      ))}
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
