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
}

interface RunParamsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  params: Record<string, ParamDef>;
  onSubmit: (values: Record<string, unknown>) => void;
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
  const hasRequired = entries.some(([_, def]) => def.required && def.default === undefined);
  const allFilled = entries.every(([key, def]) => {
    if (!def.required || def.default !== undefined) return true;
    return values[key]?.trim() !== "";
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("run_params.title")}</DialogTitle>
          <DialogDescription>{t("run_params.description")}</DialogDescription>
        </DialogHeader>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {entries.map(([key, def]) => (
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
                {def.required && def.default === undefined && (
                  <span style={{ color: "#ef4444", marginLeft: 2 }}>*</span>
                )}
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
          ))}
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
