import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
  // 跟踪待删除确认的条目的 key（用 key 而非 index，避免增删行时 index 错位）
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  // 自动取消确认的计时器
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 各个输入框的 ref，用于新增行后自动聚焦
  const keyRefs = useRef<(HTMLInputElement | null)[]>([]);

  // 当 value 变化（entries 增删）时取消确认状态，避免高亮错位
  const entriesLen = entries.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only reset when entry count changes
  useEffect(() => {
    setConfirmDeleteKey(null);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, [entriesLen]);

  // 组件卸载时清理计时器
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
      // 二次确认：真正删除
      removeEntry(index);
      setConfirmDeleteKey(null);
    } else {
      // 首次点击：进入确认状态
      setConfirmDeleteKey(entryKey);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDeleteKey(null), 3000);
    }
  };

  const addEntry = () => {
    const updated = { ...value, "": "" };
    onChange(updated);
    // 在下一帧渲染后聚焦新行的 key 输入框
    requestAnimationFrame(() => {
      const lastIdx = Object.keys(updated).length - 1;
      keyRefs.current[lastIdx]?.focus();
    });
  };

  // 在最后一个输入框按 Enter 时新增一行
  const handleKeyDown = (e: React.KeyboardEvent, index: number, field: "key" | "value") => {
    if (e.key !== "Enter" || e.shiftKey) return;
    if (field !== "value") return;
    const isLastEntry = index === entries.length - 1;
    if (!isLastEntry) return;
    e.preventDefault();
    addEntry();
  };

  return (
    <div>
      {entries.map(([k, v], i) => {
        const isConfirming = confirmDeleteKey === k && k !== "";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep input focus stable when key is being edited
          <div key={`${k}-${i}`} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
            <input
              ref={(el) => {
                keyRefs.current[i] = el;
              }}
              value={k}
              onChange={(e) => updateEntry(i, "key", e.target.value)}
              placeholder={keyPlaceholder}
              readOnly={readOnly}
              style={{
                width: "30%",
                // 空 key 视觉警告：红色边框
                ...(k.trim() === "" ? { borderColor: "#fca5a5", background: "#fef2f2" } : {}),
              }}
            />
            <input
              value={v}
              onChange={(e) => updateEntry(i, "value", e.target.value)}
              placeholder={valuePlaceholder}
              readOnly={readOnly}
              onKeyDown={(e) => handleKeyDown(e, i, "value")}
              title={t("editor.inputs_enter_to_add")}
              style={{ flex: 1 }}
            />
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
