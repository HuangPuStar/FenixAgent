import { useRequest } from "ahooks";
import { Check, LoaderCircle, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { providerApi } from "@/src/api/providers";
import { unwrap } from "@/src/api/request";
import type { ProviderInfo, ProviderModel } from "../../../types/config";
import {
  ModelField as Field,
  ModelModalityField as ModalityField,
  ModelNumberField as NumberField,
} from "./agent-model-fields";
import type {
  DiscoveryState,
  ModelDialogTarget,
  ModelDraft,
  ProviderDialogTarget,
  ProviderDraft,
} from "./agent-models-types";
import {
  buildProviderInlineTestPayload,
  formatOptionalNumber,
  getProviderKey,
  supportsThinking,
} from "./agent-models-utils";

const INPUT_MODALITIES = ["text", "image", "audio", "video", "pdf"];
const OUTPUT_MODALITIES = ["text", "image"];

interface ProviderEditorDialogProps {
  target: ProviderDialogTarget | null;
  providers: ProviderInfo[];
  saving: boolean;
  onClose: () => void;
  onSave: (draft: ProviderDraft, editing: ProviderInfo | null) => Promise<unknown>;
}

export function ProviderEditorDialog({ target, providers, saving, onClose, onSave }: ProviderEditorDialogProps) {
  const { t } = useTranslation("models");
  const editing = target && target.mode !== "create" ? target.provider : null;
  const readOnly = target?.mode === "view";
  const [draft, setDraft] = useState<ProviderDraft>({
    id: "",
    displayName: "",
    protocol: "openai",
    apiKey: "",
    baseURL: "",
    selectedModels: [],
  });
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState("");

  useEffect(() => {
    if (!target) return;
    setDraft({
      id: editing?.id ?? "",
      displayName: editing && editing.name !== editing.id ? editing.name : "",
      protocol: editing?.protocol ?? "openai",
      apiKey: "",
      baseURL: editing?.baseURL ?? "",
      selectedModels: [],
    });
    setAvailableModels([]);
    setFetchError("");
  }, [target, editing]);

  const fetchModels = useRequest(
    async () => {
      if (!draft.id.trim()) throw new Error(t("validation.nameEmpty"));
      const inline = !editing || draft.apiKey.trim() ? buildProviderInlineTestPayload(draft) : undefined;
      return unwrap(providerApi.fetchModels(editing ? getProviderKey(editing) : draft.id.trim(), inline));
    },
    {
      manual: true,
      onSuccess: ({ models }) => {
        setAvailableModels(models);
        setFetchError(models.length ? "" : t("form.noModelsFound"));
      },
      onError: (error) => {
        console.error(t("form.fetchModelsError"), error);
        setAvailableModels([]);
        setFetchError(error instanceof Error ? error.message : t("unknownError"));
      },
    },
  );

  const update = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.id.trim()) {
      toast.error(t("validation.nameEmpty"));
      return;
    }
    if (!editing && providers.some((provider) => provider.id === draft.id.trim())) {
      toast.error(t("saveProvider.duplicateName", { name: draft.id.trim() }));
      return;
    }
    try {
      await onSave(draft, editing);
      onClose();
    } catch {
      // useRequest 已统一记录和展示诊断信息，弹窗保持打开以便修正。
    }
  };

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target?.mode === "create" ? t("form.createTitle") : readOnly ? t("form.detailTitle") : t("form.editTitle")}
          </DialogTitle>
          <DialogDescription>{readOnly ? t("form.readOnlyDescription") : t("form.description")}</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
          <div className="grid min-h-0 gap-4 overflow-y-auto pr-1 sm:grid-cols-2">
            <Field label={t("form.id")}>
              <Input
                value={draft.id}
                onChange={(event) => update("id", event.target.value)}
                disabled={Boolean(editing) || readOnly}
                required
              />
            </Field>
            <Field label={t("form.displayName")}>
              <Input
                value={draft.displayName}
                onChange={(event) => update("displayName", event.target.value)}
                disabled={readOnly}
                placeholder={t("form.displayNamePlaceholder")}
              />
            </Field>
            <Field label={t("form.protocol")}>
              <Select
                value={draft.protocol}
                disabled={readOnly}
                onValueChange={(value) => update("protocol", value as ProviderDraft["protocol"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">{t("protocolOptions.openai")}</SelectItem>
                  <SelectItem value="anthropic">{t("protocolOptions.anthropic")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("form.apiKey")}>
              <Input
                type="password"
                autoComplete="new-password"
                value={draft.apiKey}
                onChange={(event) => update("apiKey", event.target.value)}
                disabled={readOnly}
                placeholder={editing ? t("form.apiKeyEditPlaceholder") : t("form.apiKeyCreatePlaceholder")}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label={t("form.baseUrl")}>
                <Input
                  value={draft.baseURL}
                  onChange={(event) => update("baseURL", event.target.value)}
                  disabled={readOnly}
                  placeholder={t("form.baseUrlPlaceholder")}
                />
              </Field>
            </div>
            {!readOnly && (
              <section className="model-dialog-section sm:col-span-2" aria-label={t("form.modelsSection")}>
                <div className="model-dialog-section__header">
                  <div>
                    <strong>{t("form.modelsSection")}</strong>
                    <small>{t("form.modelsSectionHint")}</small>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fetchModels.run()}
                    disabled={fetchModels.loading}
                  >
                    {fetchModels.loading ? <LoaderCircle className="animate-spin" /> : <Search />}
                    {fetchModels.loading ? t("form.fetching") : t("form.fetchModels")}
                  </Button>
                </div>
                {fetchError && (
                  <p className="model-dialog-error" role="alert">
                    {fetchError}
                  </p>
                )}
                {availableModels.length > 0 && (
                  <div className="model-discovery-list">
                    {availableModels.map((modelId) => {
                      const selected = draft.selectedModels.includes(modelId);
                      return (
                        <button
                          key={modelId}
                          type="button"
                          className={selected ? "is-selected" : ""}
                          onClick={() =>
                            update(
                              "selectedModels",
                              selected
                                ? draft.selectedModels.filter((id) => id !== modelId)
                                : [...draft.selectedModels, modelId],
                            )
                          }
                        >
                          <span>{modelId}</span>
                          {selected && <Check />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>
          <DialogFooter className="mt-4 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("actions.close")}
            </Button>
            {!readOnly && (
              <Button type="submit" disabled={saving}>
                {saving ? t("actions.saving") : t("actions.save")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface ModelEditorDialogProps {
  target: ModelDialogTarget | null;
  saving: boolean;
  onClose: () => void;
  onSave: (providerKey: string, draft: ModelDraft, original: ProviderModel | null) => Promise<unknown>;
}

function modelDraft(model?: ProviderModel): ModelDraft {
  const limit = (model?.limit ?? {}) as Record<string, unknown>;
  const modalities = (model?.modalities ?? {}) as { input?: string[]; output?: string[] };
  return {
    id: model?.id ?? "",
    name: model?.name ?? "",
    context: formatOptionalNumber(limit.context),
    output: formatOptionalNumber(limit.output),
    inputModalities: modalities.input ?? ["text"],
    outputModalities: modalities.output ?? ["text"],
    thinkingEnabled: model ? supportsThinking(model) : true,
  };
}

export function ModelEditorDialog({ target, saving, onClose, onSave }: ModelEditorDialogProps) {
  const { t } = useTranslation("models");
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
    <Dialog open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target?.mode === "create"
              ? t("modelSubrow.createTitle")
              : readOnly
                ? t("modelSubrow.detailTitle", { id: original?.id })
                : t("modelSubrow.editTitle", { id: original?.id })}
          </DialogTitle>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <div className="grid min-h-0 gap-4 overflow-y-auto pr-1 sm:grid-cols-2">
            <Field label={t("modelSubrow.modelId")}>
              <Input
                value={draft.id}
                disabled={Boolean(original) || readOnly}
                required
                onChange={(event) => update("id", event.target.value)}
              />
            </Field>
            <Field label={t("modelSubrow.displayName")}>
              <Input value={draft.name} disabled={readOnly} onChange={(event) => update("name", event.target.value)} />
            </Field>
            <NumberField
              label={t("modelSubrow.contextLimit")}
              value={draft.context}
              disabled={readOnly}
              onChange={(value) => update("context", value)}
            />
            <NumberField
              label={t("modelSubrow.outputLimit")}
              value={draft.output}
              disabled={readOnly}
              onChange={(value) => update("output", value)}
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
                checked={draft.thinkingEnabled}
                disabled={readOnly}
                onCheckedChange={(value) => update("thinkingEnabled", value)}
              />
            </div>
          </div>
          <DialogFooter className="mt-4 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("actions.close")}
            </Button>
            {!readOnly && (
              <Button type="submit" disabled={saving}>
                {saving ? t("actions.saving") : t("actions.save")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  const { t } = useTranslation("models");
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
  const { t } = useTranslation("models");
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
