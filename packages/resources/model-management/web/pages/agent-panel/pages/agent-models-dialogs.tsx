import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { Button } from "@fenix/ui-components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { Switch } from "@fenix/ui-components/ui/switch";
import { unwrap } from "@fenix/web-runtime/api/request";
import type { ProviderInfo, ProviderModel } from "@fenix/web-runtime/types/config";
import { useRequest } from "ahooks";
import { Check, LoaderCircle, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { providerApi } from "../../../api/providers.ts";
import { MODELS_NS } from "../../../i18n/namespace";
import { ModelModalityField as ModalityField, ModelNumberField as NumberField } from "./agent-model-fields";
import { readLimitRecord } from "./agent-models-data";
import { useProviderTestErrorText } from "./agent-models-errors";
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

/**
 * 两个编辑弹窗（Provider / 模型）共用的外壳。
 *
 * 这两处此前逐字同构：`Dialog` + `DialogContent.flex max-h-[88vh] flex-col sm:max-w-2xl` + `DialogHeader`
 * + `form.flex min-h-0 flex-1 flex-col` + `div.grid min-h-0 gap-4 overflow-y-auto pr-1 sm:grid-cols-2`
 * + 同一个 `DialogFooter`（取消 + 保存，`readOnly` 时不出提交按钮）。收在这里之后，两个弹窗只留各自的
 * 字段与提交逻辑——改外壳（高度上限、栅格、页脚）不必再同步两个函数。
 *
 * `description` 只有 Provider 弹窗有（模型弹窗不写说明），故为可选：不传就不渲染 `DialogDescription`。
 */
function EditorFormDialog({
  open,
  title,
  description,
  readOnly,
  saving,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  readOnly: boolean;
  saving: boolean;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation(MODELS_NS);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
          <div className="grid min-h-0 gap-4 overflow-y-auto pr-1 sm:grid-cols-2">{children}</div>
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

interface ProviderEditorDialogProps {
  target: ProviderDialogTarget | null;
  providers: ProviderInfo[];
  saving: boolean;
  onClose: () => void;
  onSave: (draft: ProviderDraft, editing: ProviderInfo | null) => Promise<unknown>;
}

export function ProviderEditorDialog({ target, providers, saving, onClose, onSave }: ProviderEditorDialogProps) {
  const { t } = useTranslation(MODELS_NS);
  const probeErrorText = useProviderTestErrorText();
  const editing = target && target.mode !== "create" ? target.provider : null;
  const readOnly = target?.mode === "view";
  const [draft, setDraft] = useState<ProviderDraft>({
    id: "",
    displayName: { edited: false, value: "" },
    protocol: "openai",
    apiKey: "",
    baseURL: { edited: false, value: "" },
    selectedModels: [],
  });
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState("");

  useEffect(() => {
    if (!target) return;
    setDraft({
      id: editing?.id ?? "",
      displayName: { edited: false, value: editing && editing.name !== editing.id ? editing.name : "" },
      protocol: editing?.protocol ?? "openai",
      apiKey: "",
      baseURL: { edited: false, value: editing?.baseURL ?? "" },
      selectedModels: [],
    });
    setAvailableModels([]);
    setFetchError("");
  }, [target, editing]);

  const fetchModels = useRequest(
    async () => {
      if (!draft.id.trim()) throw new Error(t("validation.nameEmpty"));
      // 编辑态下只要 Base URL 被改动过就带内联参数：Key 留空是常态（详情只回掩码、占位符就是「留空表示不
      // 修改」），只按 Key 判断会让"改了 Base URL 但没重填 Key"这次探测落到库中的旧地址上。后端的内联分支
      // 只用请求自带的凭据（空 Key 会原样发出去），因此这里改成"带新端点、凭据随表单"。
      const useInline = !editing || Boolean(draft.apiKey.trim()) || draft.baseURL.edited;
      const inline = useInline
        ? buildProviderInlineTestPayload({
            apiKey: draft.apiKey,
            baseURL: draft.baseURL.value,
            protocol: draft.protocol,
          })
        : undefined;
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
        // 探测失败的原因（上游状态码 / 响应正文摘要 / 超时 / 引用未配置）来自 `ApiError.data`。
        setFetchError(probeErrorText(error));
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
    <EditorFormDialog
      open={Boolean(target)}
      title={target?.mode === "create" ? t("form.createTitle") : readOnly ? t("form.detailTitle") : t("form.editTitle")}
      description={readOnly ? t("form.readOnlyDescription") : t("form.description")}
      readOnly={readOnly}
      saving={saving}
      onClose={onClose}
      onSubmit={handleSubmit}
    >
      <LabeledField label={t("form.id")}>
        <Input
          value={draft.id}
          onChange={(event) => update("id", event.target.value)}
          disabled={Boolean(editing) || readOnly}
          required
        />
      </LabeledField>
      <LabeledField label={t("form.displayName")}>
        <Input
          value={draft.displayName.value}
          onChange={(event) => update("displayName", { edited: true, value: event.target.value })}
          disabled={readOnly}
          placeholder={t("form.displayNamePlaceholder")}
        />
      </LabeledField>
      <LabeledField label={t("form.protocol")}>
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
      </LabeledField>
      <LabeledField label={t("form.apiKey")}>
        <Input
          type="password"
          autoComplete="new-password"
          value={draft.apiKey}
          onChange={(event) => update("apiKey", event.target.value)}
          disabled={readOnly}
          placeholder={editing ? t("form.apiKeyEditPlaceholder") : t("form.apiKeyCreatePlaceholder")}
        />
      </LabeledField>
      <div className="sm:col-span-2">
        <LabeledField label={t("form.baseUrl")}>
          <Input
            value={draft.baseURL.value}
            onChange={(event) => update("baseURL", { edited: true, value: event.target.value })}
            disabled={readOnly}
            placeholder={t("form.baseUrlPlaceholder")}
          />
        </LabeledField>
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
    </EditorFormDialog>
  );
}

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
