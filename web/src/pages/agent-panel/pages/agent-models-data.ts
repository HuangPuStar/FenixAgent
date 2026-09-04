import { useRequest } from "ahooks";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { providerApi } from "@/src/api/providers";
import { ApiError, unwrap } from "@/src/api/request";
import { dispatchConfigChange } from "../../../lib/config-events";
import type { ProviderInfo, ProviderModel } from "../../../types/config";
import type {
  DiscoveryState,
  ModelDraft,
  ModelTestState,
  ProviderCatalogData,
  ProviderDraft,
} from "./agent-models-types";
import {
  buildProviderPublicReadablePayload,
  getProviderKey,
  parseOptionalNonNegativeNumber,
} from "./agent-models-utils";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function buildModelPayload(draft: ModelDraft): Record<string, unknown> {
  const context = parseOptionalNonNegativeNumber(draft.context);
  const output = parseOptionalNonNegativeNumber(draft.output);
  const payload: Record<string, unknown> = {
    modelId: draft.id.trim(),
    name: draft.name.trim() || draft.id.trim(),
    modalities: { input: draft.inputModalities, output: draft.outputModalities },
  };
  payload.limit = context !== undefined || output !== undefined ? { context, output } : null;
  payload.options = {
    thinking: { enabled: draft.thinkingEnabled },
  };
  return payload;
}

/** 真实 Provider/Model API 的唯一页面数据控制器。 */
export function useAgentModelsData() {
  const { t } = useTranslation("models");
  const [modelTest, setModelTest] = useState<ModelTestState | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryState | null>(null);

  const catalog = useRequest<ProviderCatalogData, []>(
    async () => {
      const { providers } = await unwrap(providerApi.list());
      const details = await Promise.allSettled(
        providers.map(async (provider) => {
          const key = getProviderKey(provider);
          const detail = await unwrap(providerApi.get(key));
          return [key, detail.models ?? []] as const;
        }),
      );
      const modelsByProvider: Record<string, ProviderModel[]> = {};
      const detailFailures: string[] = [];
      details.forEach((result, index) => {
        const provider = providers[index];
        if (!provider) return;
        const key = getProviderKey(provider);
        if (result.status === "fulfilled") modelsByProvider[result.value[0]] = result.value[1];
        else {
          modelsByProvider[key] = [];
          detailFailures.push(provider.name || provider.id);
          console.error(
            t("loadProviderDetailError", { message: errorMessage(result.reason, t("unknownError")) }),
            result.reason,
          );
        }
      });
      return { providers, modelsByProvider, detailFailures };
    },
    {
      onError: (error) => {
        console.error(t("loadModelsError"), error);
        toast.error(t("loadError", { message: errorMessage(error, t("unknownError")) }));
      },
    },
  );

  const refresh = useCallback(() => catalog.refresh(), [catalog.refresh]);
  const refreshDomain = useCallback(
    (domain: "providers" | "models") => {
      refresh();
      dispatchConfigChange(domain);
    },
    [refresh],
  );

  const saveProvider = useRequest(
    async (draft: ProviderDraft, editing: ProviderInfo | null) => {
      const providerId = editing ? getProviderKey(editing) : draft.id.trim();
      const payload: Record<string, unknown> = { protocol: draft.protocol };
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey;
      if (draft.baseURL.trim()) payload.baseURL = draft.baseURL;
      if (draft.displayName.trim()) payload.name = draft.displayName.trim();
      await unwrap(providerApi.set(providerId, payload));
      const addResults = await Promise.allSettled(
        draft.selectedModels.map((modelId) => unwrap(providerApi.addModel(providerId, { modelId, name: modelId }))),
      );
      const failures = addResults.filter((result) => result.status === "rejected").length;
      if (failures > 0) throw new Error(t("form.addModelsPartialError", { count: failures }));
      return editing === null;
    },
    {
      manual: true,
      onSuccess: (created) => {
        toast.success(created ? t("saveProvider.successCreate") : t("saveProvider.successUpdate"));
        refreshDomain("providers");
        dispatchConfigChange("models");
      },
      onError: (error) => {
        // Provider 与模型由现有 API 分步写入；失败后立即重读服务端真相，避免 UI 假装整批回滚。
        refreshDomain("providers");
        dispatchConfigChange("models");
        const message = errorMessage(error, t("unknownError"));
        toast.error(
          error instanceof ApiError && error.code === "ALREADY_EXISTS"
            ? t("saveProvider.duplicateName", { name: "" })
            : t("saveProvider.errorGeneric", { message }),
        );
      },
    },
  );

  const deleteProvider = useRequest((key: string) => unwrap(providerApi.del(key)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("deleteProvider.success"));
      refreshDomain("providers");
    },
    onError: (error) => toast.error(t("deleteProvider.error", { message: errorMessage(error, t("unknownError")) })),
  });

  const togglePublic = useRequest(
    (provider: ProviderInfo, value: boolean) =>
      unwrap(providerApi.set(getProviderKey(provider), buildProviderPublicReadablePayload(value))),
    {
      manual: true,
      onSuccess: () => refreshDomain("providers"),
      onError: (error) =>
        toast.error(t("saveProvider.errorGeneric", { message: errorMessage(error, t("unknownError")) })),
    },
  );

  const saveModel = useRequest(
    async (providerKey: string, draft: ModelDraft, original: ProviderModel | null) => {
      const payload = buildModelPayload(draft);
      if (original) await unwrap(providerApi.updateModel(providerKey, original.id, payload));
      else await unwrap(providerApi.addModel(providerKey, payload));
      return original === null;
    },
    {
      manual: true,
      onSuccess: (created) => {
        toast.success(created ? t("modelSubrow.saveModel.successCreate") : t("modelSubrow.saveModel.successUpdate"));
        refreshDomain("models");
      },
      onError: (error) =>
        toast.error(t("modelSubrow.saveModel.errorGeneric", { message: errorMessage(error, t("unknownError")) })),
    },
  );

  const deleteModel = useRequest(
    (providerKey: string, modelId: string) => unwrap(providerApi.removeModel(providerKey, modelId)),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("modelSubrow.deleteModel.success"));
        refreshDomain("models");
      },
      onError: (error) =>
        toast.error(t("modelSubrow.deleteModel.error", { message: errorMessage(error, t("unknownError")) })),
    },
  );

  const testModel = useRequest(
    async (providerKey: string, modelId: string) => {
      const key = `${providerKey}:${modelId}`;
      setModelTest({ key, status: "running" });
      const result = await unwrap(providerApi.testModel(providerKey, modelId));
      return { key, detail: result.content };
    },
    {
      manual: true,
      onSuccess: ({ key, detail }) => setModelTest({ key, status: "success", detail }),
      onError: (error, [providerKey, modelId]) =>
        setModelTest({
          key: `${providerKey}:${modelId}`,
          status: "error",
          detail: errorMessage(error, t("unknownError")),
        }),
    },
  );

  const discoverModels = useRequest(
    async (providerKey: string, existing: ProviderModel[]) => {
      const result = await unwrap(providerApi.fetchModels(providerKey));
      return {
        providerKey,
        models: result.models,
        addedIds: new Set(existing.map((model) => model.id)),
      } satisfies DiscoveryState;
    },
    {
      manual: true,
      onSuccess: setDiscovery,
      onError: (error) => toast.error(t("testDialog.testError", { message: errorMessage(error, t("unknownError")) })),
    },
  );

  const addDiscoveredModel = useRequest(
    async (providerKey: string, modelId: string) => {
      await unwrap(providerApi.addModel(providerKey, { modelId, name: modelId }));
      return { providerKey, modelId };
    },
    {
      manual: true,
      onSuccess: ({ modelId }) => {
        setDiscovery((current) =>
          current ? { ...current, addedIds: new Set(current.addedIds).add(modelId) } : current,
        );
        toast.success(t("testDialog.addModelSuccess", { modelId }));
        refreshDomain("models");
      },
      onError: (error) =>
        toast.error(t("testDialog.addModelError", { message: errorMessage(error, t("unknownError")) })),
    },
  );

  return {
    catalog,
    saveProvider,
    deleteProvider,
    togglePublic,
    saveModel,
    deleteModel,
    testModel,
    modelTest,
    discoverModels,
    discovery,
    setDiscovery,
    addDiscoveredModel,
  };
}
