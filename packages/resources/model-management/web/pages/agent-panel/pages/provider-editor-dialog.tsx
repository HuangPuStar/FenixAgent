import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { unwrap } from "@fenix/web-runtime/api/request";
import type { ProviderInfo } from "@fenix/web-runtime/types/config";
import { useRequest } from "ahooks";
import { Check, LoaderCircle, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { providerApi } from "../../../api/providers.ts";
import { MODELS_NS } from "../../../i18n/namespace";
import { useProviderTestErrorText } from "./agent-models-errors";
import type { ProviderDialogTarget, ProviderDraft } from "./agent-models-types";
import { buildProviderInlineTestPayload, getProviderKey, mergeModelCandidates } from "./agent-models-utils";
import { EditorFormDialog } from "./editor-form-dialog";

interface ProviderEditorDialogProps {
  target: ProviderDialogTarget | null;
  providers: ProviderInfo[];
  saving: boolean;
  onClose: () => void;
  onSave: (draft: ProviderDraft, editing: ProviderInfo | null) => Promise<unknown>;
}

/**
 * Provider 编辑器（新建 / 编辑 / 查看）与它的「取模型列表」内联探测。
 *
 * 从 `agent-models-dialogs.tsx` 拆出（§4.7）：本弹窗只服务 Provider 这一条数据流，模型侧的
 * 编辑 / 发现 / 删除弹窗留在 `agent-models-dialogs.tsx`，共用外壳在 `editor-form-dialog.tsx`。
 */
export function ProviderEditorDialog({ target, providers, saving, onClose, onSave }: ProviderEditorDialogProps) {
  const { t } = useTranslation(MODELS_NS);
  const probeErrorText = useProviderTestErrorText();
  const editing = target && target.mode !== "create" ? target.provider : null;
  const readOnly = target?.mode === "view";
  // 草稿取自装配点传入的 `target`，**没有回填 effect**（§4.2 / §4.3）：调用方按「每次打开换一个 `key`」
  // 渲染本组件，mount 时的初始化器就是那一份新草稿。此前靠 `useEffect([target, editing])` 回填，
  // 关掉再打开同一个 Provider 时依赖不变、effect 不跑，上一次的输入（含探测出的模型列表）会留在原位。
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    editing
      ? {
          id: editing.id,
          displayName: { edited: false, value: editing.name !== editing.id ? editing.name : "" },
          protocol: editing.protocol,
          apiKey: "",
          baseURL: { edited: false, value: editing.baseURL ?? "" },
          selectedModels: [],
        }
      : {
          id: "",
          displayName: { edited: false, value: "" },
          protocol: "openai",
          apiKey: "",
          baseURL: { edited: false, value: "" },
          selectedModels: [],
        },
  );
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState("");
  const [manualModelId, setManualModelId] = useState("");

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

  const manualId = manualModelId.trim();

  /**
   * 手动登记一个模型 ID。
   *
   * 这不是探测失败的降级路径，而是部分服务商的**唯一**配置路径：列表接口与消息接口不总在同一地址上
   * （Anthropic 兼容端点常只实现 `/v1/messages`），探测必然 404，而模型本身是可用的。
   */
  const addManualModel = () => {
    if (manualId === "") return;
    if (draft.selectedModels.includes(manualId)) {
      toast.error(t("form.manualModelDuplicate", { modelId: manualId }));
      return;
    }
    update("selectedModels", [...draft.selectedModels, manualId]);
    setManualModelId("");
  };

  // 候选集是"探测结果 + 已选手动条目"：手动条目不在探测结果里，但也必须可见、可取消。
  const modelCandidates = mergeModelCandidates(availableModels, draft.selectedModels);

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
          {/* 手动入口与「获取模型列表」并列，不藏在探测成功之后：这正是列表接口拿不到时唯一能走的路。 */}
          <div className="model-dialog-section__manual">
            <Input
              value={manualModelId}
              onChange={(event) => setManualModelId(event.target.value)}
              // 外壳是 <form>，回车默认提交整份服务商表单；这一行把回车收成"添加"。
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addManualModel();
              }}
              aria-label={t("form.manualModelLabel")}
              placeholder={t("form.manualModelPlaceholder")}
            />
            <Button type="button" variant="outline" size="sm" onClick={addManualModel} disabled={manualId === ""}>
              {t("actions.add")}
            </Button>
          </div>
          {fetchError && (
            <p className="model-dialog-error" role="alert">
              {fetchError}
            </p>
          )}
          {modelCandidates.length > 0 && (
            <div className="model-discovery-list">
              {modelCandidates.map((modelId) => {
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
