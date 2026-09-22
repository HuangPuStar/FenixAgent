import { ApiError, unwrap } from "@fenix/web-runtime/api/request";
import { dispatchConfigChange } from "@fenix/web-runtime/lib/config-events";
import type { ProviderInfo, ProviderModel } from "@fenix/web-runtime/types/config";
import { useRequest } from "ahooks";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { providerApi } from "../../../api/providers.ts";
import { MODELS_NS } from "../../../i18n/namespace";
import { canManageProviderSharing } from "../../../lib/provider-resource-access";
import { useProviderTestErrorText } from "./agent-models-errors";
import type {
  DiscoveryState,
  ModelDraft,
  ModelLimitDraft,
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

/**
 * `limit_config` 列的 jsonb 读取：返回可安全改写的一层浅拷贝。
 *
 * 该列由后端原样透传（`limit: model.limitConfig ?? null`），前端表单只认识 `context` / `output`，而领域
 * 类型里还有 `rpm` 等由消费方约定的键——合并写回前必须先读回整份对象，否则一次编辑就会抹掉它们。非对象
 * （含数组、标量）一律当作空对象，与 `options` 的读取判据一致。
 */
export function readLimitRecord(limit: unknown): Record<string, unknown> {
  return limit !== null && typeof limit === "object" && !Array.isArray(limit)
    ? { ...(limit as Record<string, unknown>) }
    : {};
}

/**
 * `limit_config` 列写载荷。
 *
 * 先合并该列原有键（`rpm` 等表单之外的键必须原样保留），再按用户的编辑覆盖 `context` / `output`：填了
 * 值就写数字，清空则删掉该键——「清空输入框」表达的是"这个键不再有配置"，而领域里"缺键即未配置"，写
 * `null` 只会让下游多出一种要处理的"没有值"。
 *
 * 合并后一个键都不剩时整列提交 `null`：这正是"该模型没有 limit 配置"的表达（新建且两框都空也是它）。
 */
function buildLimitPayload(limit: ModelLimitDraft, original: unknown): Record<string, unknown> | null {
  const merged = readLimitRecord(original);
  const context = parseOptionalNonNegativeNumber(limit.context);
  const output = parseOptionalNonNegativeNumber(limit.output);
  if (context === undefined) delete merged.context;
  else merged.context = context;
  if (output === undefined) delete merged.output;
  else merged.output = output;
  return Object.keys(merged).length > 0 ? merged : null;
}

/**
 * 模型写载荷。
 *
 * `limit` / `options` 两列的写入语义由后端定义：键缺省 = 不修改该列，一旦提交就是**整列覆盖**。因此只在
 * 用户触碰过对应控件（或新建——没有既存列可保留）时才带上该键，并且必须合并列内原有的其它键，否则一次
 * 编辑就会抹掉用户没动过的键（`limit_config.rpm`、`options.temperature` 等）。
 */
function buildModelPayload(draft: ModelDraft, original: ProviderModel | null): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    modelId: draft.id.trim(),
    name: draft.name.trim() || draft.id.trim(),
    modalities: { input: draft.inputModalities, output: draft.outputModalities },
  };
  if (original === null || draft.limit.edited) payload.limit = buildLimitPayload(draft.limit, original?.limit);
  if (original === null || draft.thinking.edited) {
    payload.options = { ...(original?.options ?? {}), thinking: { enabled: draft.thinking.enabled } };
  }
  return payload;
}

/**
 * 触碰过的 Provider 文本字段的提交值：空 = 清空，非空 = 去掉首尾空白的新值。
 *
 * 清空必须走显式 `null`（`ProviderWriteData.baseUrl?: string | null`），后端只把 `undefined` 读作"不修改"；
 * 这里刻意不用 `||` 兜底，因为空串在这个字段上是有含义的输入。
 */
function providerFieldValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** 真实 Provider/Model API 的唯一页面数据控制器。 */
export function useAgentModelsData() {
  const { t } = useTranslation(MODELS_NS);
  const probeErrorText = useProviderTestErrorText();
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
      // API Key 的语义与显示名 / Base URL 不同：输入框恒空是回显约定（详情只回 `keyHint` 掩码），空值提交
      // 会把用户的密钥清掉，所以这里保持"空 = 不提交该键"。
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey;
      // 显示名与 Base URL 走字段级 dirty：未触碰 → 缺省键（后端不改该列）；触碰后为空 → `null`（清空）。
      if (draft.baseURL.edited) payload.baseURL = providerFieldValue(draft.baseURL.value);
      if (draft.displayName.edited) payload.name = providerFieldValue(draft.displayName.value);
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
    (provider: ProviderInfo, value: boolean) => {
      // 公开受众只对具备 `update` 动作的主体开放；缺失动作时前端直接拒绝，不发必然 403 的请求。
      if (!canManageProviderSharing(provider)) throw new Error(t("errors.sharingUnavailable"));
      return unwrap(providerApi.set(getProviderKey(provider), buildProviderPublicReadablePayload(value)));
    },
    {
      manual: true,
      onSuccess: () => refreshDomain("providers"),
      onError: (error) =>
        toast.error(t("saveProvider.errorGeneric", { message: errorMessage(error, t("unknownError")) })),
    },
  );

  const saveModel = useRequest(
    async (providerKey: string, draft: ModelDraft, original: ProviderModel | null) => {
      const payload = buildModelPayload(draft, original);
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
          // 探测失败带诊断数据（上游状态码 / 响应正文摘要 / 超时区分），不能只显示内部错误码。
          detail: probeErrorText(error),
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
      onError: (error) => toast.error(t("testDialog.testError", { message: probeErrorText(error) })),
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
