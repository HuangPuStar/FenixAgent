import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog";

export interface ParamDef {
  type?: "string" | "number" | "boolean" | "object";
  default?: unknown;
  required?: boolean;
  /** 参数分组标识。未设归默认组（置顶展开），"advance" 归高级组（底部折叠） */
  group?: string;
}

interface RunParamsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  params: Record<string, ParamDef>;
  onSubmit: (values: Record<string, unknown>) => void;
}

/** 可折叠分组容器 — toggle 展开/收起 */
function CollapsibleGroup({
  label,
  defaultOpen,
  children,
}: {
  label: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          cursor: "pointer",
          fontWeight: 600,
          color: "#374151",
          fontSize: 12,
          padding: "6px 0",
          borderBottom: "1px solid #e5e7eb",
          marginBottom: 4,
        }}
      >
        <span
          style={{ fontSize: 10, transition: "transform 0.15s", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
        {label}
      </div>
      {open && <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>}
    </div>
  );
}

export function RunParamsDialog({ open, onOpenChange, params, onSubmit }: RunParamsDialogProps) {
  const { t } = useTranslation("workflows");
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [key, def] of Object.entries(params)) {
      init[key] = def.default !== undefined ? String(def.default) : "";
    }
    return init;
  });

  const resetValues = useCallback(() => {
    const init: Record<string, string> = {};
    for (const [key, def] of Object.entries(params)) {
      init[key] = def.default !== undefined ? String(def.default) : "";
    }
    setValues(init);
  }, [params]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) resetValues();
      onOpenChange(nextOpen);
    },
    [onOpenChange, resetValues],
  );

  const handleSubmit = useCallback(() => {
    const resolved: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(params)) {
      const raw = values[key];
      if (raw === "" || raw === undefined) {
        if (def.default !== undefined) resolved[key] = def.default;
        continue;
      }
      switch (def.type) {
        case "number":
          resolved[key] = Number(raw);
          break;
        case "boolean":
          resolved[key] = raw === "true" || raw === "1";
          break;
        default:
          resolved[key] = raw;
      }
    }
    onSubmit(resolved);
    resetValues();
    onOpenChange(false);
  }, [params, values, onSubmit, onOpenChange, resetValues]);

  const entries = Object.entries(params);

  // 按 group 分组，"advance" 排在最后
  const groups: Array<{ groupKey: string; label: string; entries: [string, ParamDef][]; collapsed: boolean }> = (() => {
    const map = new Map<string, [string, ParamDef][]>();
    for (const [key, def] of entries) {
      const g = def.group ?? "";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push([key, def]);
    }
    const result: Array<{ groupKey: string; label: string; entries: [string, ParamDef][]; collapsed: boolean }> = [];
    for (const [groupKey, list] of map) {
      const isAdvance = groupKey === "advance";
      result.push({
        groupKey,
        label: isAdvance ? t("editor.group_advance") : t("editor.group_default"),
        entries: list,
        collapsed: isAdvance,
      });
    }
    // advance 排最后
    result.sort((a, b) => (a.groupKey === "advance" ? 1 : b.groupKey === "advance" ? -1 : 0));
    return result;
  })();
  const hasRequired = entries.some(([_, def]) => def.required && def.default === undefined);
  const allFilled = entries.every(([key, def]) => {
    if (!def.required || def.default !== undefined) return true;
    return values[key]?.trim() !== "";
  });

  // 单个字段渲染
  function renderField(key: string, def: ParamDef) {
    return (
      <div key={key}>
        <label
          style={{
            display: "block",
            fontSize: 12,
            fontWeight: 500,
            color: "#374151",
            marginBottom: 4,
          }}
        >
          {key}
          {def.required && def.default === undefined && <span style={{ color: "#ef4444", marginLeft: 2 }}>*</span>}
          {def.type && def.type !== "string" && (
            <span style={{ color: "#9ca3af", fontWeight: 400, marginLeft: 6 }}>({def.type})</span>
          )}
        </label>
        <input
          value={values[key] ?? ""}
          onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
          placeholder={
            def.default !== undefined
              ? String(def.default)
              : def.required
                ? t("run_params.required_placeholder")
                : t("run_params.optional_placeholder")
          }
          style={{
            width: "100%",
            padding: "6px 10px",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            fontSize: 13,
            outline: "none",
          }}
        />
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("run_params.title")}</DialogTitle>
          <DialogDescription>{t("run_params.description")}</DialogDescription>
        </DialogHeader>

        <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
          {groups.length > 1
            ? groups.map(({ groupKey, label, entries: groupEntries, collapsed }) => (
                // 仅多组时按组折叠，单组扁铺
                <CollapsibleGroup key={groupKey} label={label} defaultOpen={!collapsed}>
                  {groupEntries.map(([key, def]) => renderField(key, def))}
                </CollapsibleGroup>
              ))
            : // 单组或无 group → 扁平渲染（行为与旧版一致）
              entries.map(([key, def]) => renderField(key, def))}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            style={{
              padding: "6px 12px",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              background: "#fff",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {t("run_params.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allFilled}
            style={{
              padding: "6px 12px",
              border: "none",
              borderRadius: 6,
              background: allFilled ? "#3b82f6" : "#93c5fd",
              color: "#fff",
              fontSize: 12,
              cursor: allFilled ? "pointer" : "not-allowed",
            }}
          >
            {t("run_params.submit")}
          </button>
        </DialogFooter>

        {!hasRequired && <div style={{ fontSize: 11, color: "#9ca3af" }}>{t("run_params.all_optional_hint")}</div>}
      </DialogContent>
    </Dialog>
  );
}
