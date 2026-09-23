import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Switch } from "@fenix/ui-components/ui/switch";
import type { ProviderInfo, ProviderModel } from "@fenix/web-runtime/types/config";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MODELS_NS } from "../../../i18n/namespace";
import { ModelModalityField as ModalityField, ModelNumberField as NumberField } from "./agent-model-fields";
import { readLimitRecord } from "./agent-models-data";
import type { DiscoveryState, ModelDialogTarget, ModelDraft } from "./agent-models-types";
import { formatOptionalNumber, supportsThinking } from "./agent-models-utils";
import { EditorFormDialog } from "./editor-form-dialog";

// 模型侧弹窗集合：模型条目编辑 / 发现结果 / 删除确认。
// Provider 编辑器与共用外壳已按 §4.7 拆到 `provider-editor-dialog.tsx` 与 `editor-form-dialog.tsx`。

const INPUT_MODALITIES = ["text", "image", "audio", "video", "pdf"];
const OUTPUT_MODALITIES = ["text", "image"];

interface ModelEditorDialogProps {
  target: ModelDialogTarget | null;
  saving: boolean;
  onClose: () => void;
  onSave: (providerKey: string, draft: ModelDraft, original: ProviderModel | null) => Promise<unknown>;
}

function modelDraft(model?: ProviderModel): ModelDraft {
  const limit = readLimitRecord(model?.limit);
  const modalities = (model?.modalities ?? {}) as { input?: string[]; output?: string[] };
  return {
    id: model?.id ?? "",
    name: model?.name ?? "",
    // 编辑时按列中真实值回显，并标记为「未触碰」：只有用户动过数字框才允许提交该列。
    limit: { edited: false, context: formatOptionalNumber(limit.context), output: formatOptionalNumber(limit.output) },
    inputModalities: modalities.input ?? ["text"],
    outputModalities: modalities.output ?? ["text"],
    // 新建时开关默认打开；编辑时按真实 `options.thinking.enabled` 回显，并标记为「未触碰」。
    thinking: { edited: false, enabled: model ? supportsThinking(model) : true },
  };
}

export function ModelEditorDialog({ target, saving, onClose, onSave }: ModelEditorDialogProps) {
  const { t } = useTranslation(MODELS_NS);
  const original = target && "model" in target ? target.model : null;
  const readOnly = target?.mode === "view";
  const [draft, setDraft] = useState<ModelDraft>(() => modelDraft());
  useEffect(() => {
    setDraft(modelDraft(original ?? undefined));
  }, [original]);
  const update = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const toggle = (key: "inputModalities" | "outputModalities", value: string) =>
    update(key, draft[key].includes(value) ? draft[key].filter((item) => item !== value) : [...draft[key], value]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!target || !draft.id.trim()) return;
    try {
      await onSave(target.providerKey, draft, original);
      onClose();
    } catch {
      /* mutation keeps the form open */
    }
  };
  return (
    <EditorFormDialog
      open={Boolean(target)}
      title={
        target?.mode === "create"
          ? t("modelSubrow.createTitle")
          : readOnly
            ? t("modelSubrow.detailTitle", { id: original?.id })
            : t("modelSubrow.editTitle", { id: original?.id })
      }
      readOnly={readOnly}
      saving={saving}
      onClose={onClose}
      onSubmit={submit}
    >
      <LabeledField label={t("modelSubrow.modelId")}>
        <Input
          value={draft.id}
          disabled={Boolean(original) || readOnly}
          required
          onChange={(event) => update("id", event.target.value)}
        />
      </LabeledField>
      <LabeledField label={t("modelSubrow.displayName")}>
        <Input value={draft.name} disabled={readOnly} onChange={(event) => update("name", event.target.value)} />
      </LabeledField>
      <NumberField
        label={t("modelSubrow.contextLimit")}
        value={draft.limit.context}
        disabled={readOnly}
        onChange={(value) => update("limit", { edited: true, context: value, output: draft.limit.output })}
      />
      <NumberField
        label={t("modelSubrow.outputLimit")}
        value={draft.limit.output}
        disabled={readOnly}
        onChange={(value) => update("limit", { edited: true, context: draft.limit.context, output: value })}
      />
      <ModalityField
        label={t("modelSubrow.inputModality")}
        values={INPUT_MODALITIES}
        selected={draft.inputModalities}
        disabled={readOnly}
        onToggle={(value) => toggle("inputModalities", value)}
      />
      <ModalityField
        label={t("modelSubrow.outputModality")}
        values={OUTPUT_MODALITIES}
        selected={draft.outputModalities}
        disabled={readOnly}
        onToggle={(value) => toggle("outputModalities", value)}
      />
      <div className="model-thinking-field sm:col-span-2">
        <div>
          <strong>{t("modelSubrow.thinkingEnabled")}</strong>
          <small>{t("modelSubrow.thinkingDescription")}</small>
        </div>
        <Switch
          checked={draft.thinking.enabled}
          disabled={readOnly}
          onCheckedChange={(value) => update("thinking", { edited: true, enabled: value })}
        />
      </div>
    </EditorFormDialog>
  );
}

export function DiscoveryDialog({
  state,
  adding,
  onClose,
  onAdd,
}: {
  state: DiscoveryState | null;
  adding: boolean;
  onClose: () => void;
  onAdd: (providerKey: string, modelId: string) => void;
}) {
  const { t } = useTranslation(MODELS_NS);
  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("form.modelsSection")}</DialogTitle>
          <DialogDescription>
            {state ? t("testDialog.modelsFound", { count: state.models.length }) : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="model-discovery-list is-dialog">
          {state?.models.map((modelId) => {
            const added = state.addedIds.has(modelId);
            return (
              <div key={modelId}>
                <span>{modelId}</span>
                {added ? (
                  <small>
                    <Check />
                    {t("testDialog.added")}
                  </small>
                ) : (
                  <Button size="xs" variant="ghost" disabled={adding} onClick={() => onAdd(state.providerKey, modelId)}>
                    {t("actions.add")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ModelDeleteDialogs({
  provider,
  model,
  deleting,
  onCloseProvider,
  onCloseModel,
  onDeleteProvider,
  onDeleteModel,
}: {
  provider: ProviderInfo | null;
  model: { providerKey: string; model: ProviderModel } | null;
  deleting: boolean;
  onCloseProvider: () => void;
  onCloseModel: () => void;
  onDeleteProvider: () => void;
  onDeleteModel: () => void;
}) {
  const { t } = useTranslation(MODELS_NS);
  return (
    <>
      <ConfirmDialog
        open={Boolean(provider)}
        onOpenChange={onCloseProvider}
        title={t("deleteProvider.confirmTitle")}
        description={t("deleteProvider.confirmDesc", { name: provider?.name ?? "" })}
        variant="destructive"
        loading={deleting}
        onConfirm={onDeleteProvider}
      />
      <ConfirmDialog
        open={Boolean(model)}
        onOpenChange={onCloseModel}
        title={t("modelSubrow.deleteModel.confirmTitle")}
        description={t("modelSubrow.deleteModel.confirmDesc", { id: model?.model.id ?? "" })}
        variant="destructive"
        loading={deleting}
        onConfirm={onDeleteModel}
      />
    </>
  );
}
