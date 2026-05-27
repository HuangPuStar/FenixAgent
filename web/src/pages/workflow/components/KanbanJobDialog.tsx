import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { workflowDefApi } from "../../../api/sdk";
import type { WorkflowJob } from "../../../api/workflow-jobs";
import { workflowJobsApi } from "../../../api/workflow-jobs";

interface ParamDef {
  type?: "string" | "number" | "boolean" | "object";
  default?: unknown;
  required?: boolean;
}

interface WorkflowOption {
  id: string;
  name: string;
  description?: string | null;
}

interface KanbanJobDialogProps {
  open: boolean;
  onClose: () => void;
  editJob: WorkflowJob | null;
  onRefresh: () => void;
}

export function KanbanJobDialog({ open, onClose, editJob, onRefresh }: KanbanJobDialogProps) {
  const { t } = useTranslation("kanban");
  const isEdit = !!editJob;

  const [workflows, setWorkflows] = useState<WorkflowOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [paramDefs, setParamDefs] = useState<Record<string, ParamDef>>({});
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [loadingParams, setLoadingParams] = useState(false);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState<number | null>(null);

  // 加载工作流列表
  useEffect(() => {
    if (!open) return;
    workflowDefApi
      .list()
      .then(({ data, error }) => {
        if (error) throw new Error(error.message);
        setWorkflows(
          (Array.isArray(data) ? data : []).map((wf: Record<string, unknown>) => ({
            id: wf.id as string,
            name: wf.name as string,
            description: wf.description as string | null,
          })),
        );
      })
      .catch((err) => {
        console.error(err);
        toast.error(t("load_failed", { error: err.message }));
      });
  }, [open, t]);

  // 编辑模式：预填参数
  useEffect(() => {
    if (editJob) {
      setSelectedId(editJob.workflowId);
      setParamValues(editJob.params ?? {});
      setVersion(editJob.version);
    } else {
      setSelectedId("");
      setParamValues({});
      setVersion(null);
    }
  }, [editJob]);

  // 选择工作流后加载参数定义
  useEffect(() => {
    if (!selectedId || isEdit) return;
    setLoadingParams(true);
    setParamDefs({});
    setParamValues({});

    const loadParams = async () => {
      try {
        const res = await fetch("/web/workflow-defs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action: "getParamDefs", workflowId: selectedId }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error?.message ?? "Failed");
        const result = json.data;
        setParamDefs(result.params ?? {});
        setVersion(result.version);
        const defaults: Record<string, unknown> = {};
        for (const [key, def] of Object.entries(result.params ?? {})) {
          if ((def as ParamDef).default !== undefined) defaults[key] = (def as ParamDef).default;
        }
        setParamValues(defaults);
      } catch (err) {
        console.error(err);
        toast.error(t("dialog_load_params_failed"));
      } finally {
        setLoadingParams(false);
      }
    };
    loadParams();
  }, [selectedId, isEdit, t]);

  const handleSubmit = useCallback(async () => {
    setSaving(true);
    try {
      if (isEdit) {
        await workflowJobsApi.updateParams(editJob.id, paramValues);
        toast.success(t("dialog_save"));
      } else {
        await workflowJobsApi.create(selectedId, paramValues);
        toast.success(t("dialog_create"));
      }
      onRefresh();
      onClose();
    } catch (err) {
      console.error(err);
      toast.error(isEdit ? t("dialog_save_failed") : t("dialog_create_failed"));
    } finally {
      setSaving(false);
    }
  }, [editJob, isEdit, selectedId, paramValues, onRefresh, onClose, t]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("dialog_edit_title") : t("dialog_create_title")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!isEdit && (
            <div className="space-y-1.5">
              <Label className="text-[11px] font-semibold tracking-wide uppercase text-text-dim">
                {t("dialog_select_workflow")}
              </Label>
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                className="w-full rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-brand focus:ring-2 focus:ring-brand-subtle focus:outline-none transition-colors"
              >
                <option value="">{t("dialog_select_workflow_placeholder")}</option>
                {workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {wf.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {version !== null && (
            <div className="inline-flex items-center gap-1 text-[11px] font-mono text-text-dim bg-surface-2 rounded px-2 py-0.5">
              v{version}
            </div>
          )}

          {loadingParams && (
            <div className="flex items-center gap-2 text-xs text-text-muted">
              <Loader2 size={14} className="animate-spin" /> {t("dialog_loading_params")}
            </div>
          )}

          {!loadingParams && Object.keys(paramDefs).length > 0 && (
            <div className="space-y-3">
              <div className="text-[11px] font-semibold tracking-wide uppercase text-text-dim">
                {t("dialog_params_title")}
              </div>
              {Object.entries(paramDefs).map(([key, def]) => (
                <div key={key} className="space-y-1">
                  <Label className="text-xs flex items-center gap-1 text-text-primary">
                    {key}
                    {def.required && <span className="text-red-500">*</span>}
                  </Label>
                  {def.type === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={!!paramValues[key]}
                      onChange={(e) => setParamValues((v) => ({ ...v, [key]: e.target.checked }))}
                      className="rounded"
                    />
                  ) : (
                    <Input
                      type={def.type === "number" ? "number" : "text"}
                      value={String(paramValues[key] ?? "")}
                      onChange={(e) =>
                        setParamValues((v) => ({
                          ...v,
                          [key]: def.type === "number" ? Number(e.target.value) : e.target.value,
                        }))
                      }
                      className="h-8 text-sm"
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {!loadingParams && selectedId && Object.keys(paramDefs).length === 0 && (
            <div className="text-xs text-text-muted">{t("dialog_no_params")}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("dialog_cancel")}
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving || (!isEdit && !selectedId)}>
            {saving ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
            {isEdit ? t("dialog_save") : t("dialog_create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
