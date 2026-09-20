import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * 工作流节点 inputs 编辑器。
 *
 * ⚠️  设计要点：使用本地 draft + blur 提交模式，而非直接 onChange 通知父组件。
 * 原因：父组件收到 onChange 后会更新 ReactFlow node state，导致 WorkflowNode
 * 的 inputPoints 重算、Handle 重挂载，引发 IME 输入法字符重复、连线断开等问题。
 * blur 时一次性提交，保证输入阶段零副作用。
 */

/** 本地编辑状态：输入时不立即通知父组件，blur 时一次性提交 */
interface DraftEntry {
  /**
   * 草稿行的稳定标识，只用于 React key（不参与提交）：`key` 字段由用户编辑，可能为空或重复，
   * 不能当 key——输入中改键名或删中间行会让整行重挂载，打断 IME 组合（本组件存在的原因见文件头注释）。
   */
  id: string;
  key: string;
  value: string;
}

/**
 * 草稿行 id 的进程内计数器：只在创建行时递增，保证同一个组件实例内 id 唯一且与行内容无关。
 * 不用数组下标：删除中间行时后续行会「继承」前一行的 key，正是 noArrayIndexKey 拦下的那类问题。
 */
let draftRowCounter = 0;

const createDraftRow = (key: string, value: string): DraftEntry => ({
  id: `draft-row-${draftRowCounter++}`,
  key,
  value,
});

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
  const [drafts, setDrafts] = useState<DraftEntry[]>(() =>
    Object.entries(value ?? {}).map(([k, v]) => createDraftRow(k, v)),
  );
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focusKeyIdx, setFocusKeyIdx] = useState<number | null>(null);

  // 当父组件传入的 value 条目数变化时（新增/删除行），同步本地 draft
  // 条数不变时不做同步（保留本地编辑中的文本）
  const prevEntryCountRef = useRef(Object.keys(value ?? {}).length);
  useEffect(() => {
    const newCount = Object.keys(value ?? {}).length;
    if (newCount !== prevEntryCountRef.current) {
      prevEntryCountRef.current = newCount;
      setDrafts(Object.entries(value ?? {}).map(([k, v]) => createDraftRow(k, v)));
    }
  }, [value]);

  useEffect(() => {
    setConfirmDeleteKey(null);
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  /** 将本地 draft 提交到父组件 */
  const commit = (draftEntries: DraftEntry[]) => {
    const result: Record<string, string> = {};
    for (const e of draftEntries) {
      if (e.key) result[e.key] = e.value;
    }
    onChange(Object.keys(result).length === 0 ? undefined : result);
  };

  const updateDraft = (index: number, field: "key" | "value", newVal: string) => {
    setDrafts((prev) => {
      const next = prev.map((e, i) => (i === index ? { ...e, [field]: newVal } : e));
      return next;
    });
  };

  const handleBlur = (_index: number) => {
    setDrafts((prev) => {
      commit(prev);
      return prev;
    });
  };

  const removeEntry = (index: number) => {
    setDrafts((prev) => {
      const next = prev.filter((_, i) => i !== index);
      commit(next);
      return next;
    });
    setConfirmDeleteKey(null);
  };

  const handleDeleteClick = (index: number) => {
    const entryKey = drafts[index]?.key;
    if (confirmDeleteKey === entryKey && entryKey) {
      removeEntry(index);
    } else if (entryKey) {
      setConfirmDeleteKey(entryKey);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = setTimeout(() => setConfirmDeleteKey(null), 3000);
    }
  };

  const addEntry = () => {
    setDrafts((prev) => {
      const next = [...prev, createDraftRow("", "")];
      setFocusKeyIdx(next.length - 1);
      return next;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key !== "Enter" || e.shiftKey) return;
    const isLastEntry = index === drafts.length - 1;
    if (!isLastEntry) return;
    e.preventDefault();
    // 先提交当前内容，再追加空行
    setDrafts((prev) => {
      commit(prev);
      return prev;
    });
    addEntry();
  };

  const isEmptyKey = (k: string) => k.trim() === "";

  return (
    <div className="flex flex-col gap-1">
      {drafts.map((entry, i) => {
        const isConfirming = confirmDeleteKey === entry.key && entry.key !== "";
        return (
          <div key={entry.id} className="flex items-center gap-1">
            <Input
              value={entry.key}
              onChange={(e) => updateDraft(i, "key", e.target.value)}
              onBlur={() => handleBlur(i)}
              placeholder={keyPlaceholder}
              readOnly={readOnly}
              autoFocus={i === focusKeyIdx}
              className={`h-8 text-xs ${isEmptyKey(entry.key) ? "border-red-300 bg-red-50" : ""}`}
              style={{ width: "30%" }}
            />
            <Input
              value={entry.value}
              onChange={(e) => updateDraft(i, "value", e.target.value)}
              onBlur={() => handleBlur(i)}
              onKeyDown={(e) => handleKeyDown(e, i)}
              placeholder={valuePlaceholder}
              readOnly={readOnly}
              title={t("editor.inputs_enter_to_add")}
              className="flex-1 h-8 text-xs"
            />
            {!readOnly && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleDeleteClick(i)}
                title={isConfirming ? t("editor.delete_confirm_hint") : undefined}
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
