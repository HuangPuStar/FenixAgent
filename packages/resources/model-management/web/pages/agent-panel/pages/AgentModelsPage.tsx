import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { useOrgSession } from "@fenix/web-runtime/contexts/org-session";
import type { ProviderInfo, ProviderModel } from "@fenix/web-runtime/types/config";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentModelsCatalog } from "./agent-models-catalog";
import { useAgentModelsData } from "./agent-models-data";
import { DiscoveryDialog, ModelDeleteDialogs, ModelEditorDialog, ProviderEditorDialog } from "./agent-models-dialogs";
import type { ModelDialogTarget, ProviderDialogTarget } from "./agent-models-types";
import { getProviderKey, type ProviderScope, providerMatchesScope } from "./agent-models-utils";
import "./agent-models.css";
import "./agent-models-dialogs.css";
import "./agent-models-states.css";
import { MODELS_NS } from "../../../i18n/namespace";

export function AgentModelsPage() {
  const { t } = useTranslation(MODELS_NS);
  const navigate = useNavigate();
  // 当前组织 id 用于判定 Provider 归属：`/web` 视图只给 scope.organizationId，需本地比对才知道是否共享来源。
  // 取值经 `@fenix/web-runtime` 的 org/session 契约（§1.6 T7），实现方是身份包的 `OrgProvider`。
  const { organizationId } = useOrgSession();
  // 契约用 `null` 表示「无活动组织」，本包比较函数与子组件的入参口径是 `string | undefined`：
  // 在取值处一次归一，调用点保持既有形状，避免把 `| null` 扩散进各处签名。
  const activeOrganizationId = organizationId ?? undefined;
  const data = useAgentModelsData();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ProviderScope>("all");
  const [selectedKey, setSelectedKey] = useState("");
  const [providerDialog, setProviderDialog] = useState<ProviderDialogTarget | null>(null);
  const [modelDialog, setModelDialog] = useState<ModelDialogTarget | null>(null);
  const [deleteProvider, setDeleteProvider] = useState<ProviderInfo | null>(null);
  const [deleteModel, setDeleteModel] = useState<{ providerKey: string; model: ProviderModel } | null>(null);

  const providers = data.catalog.data?.providers ?? [];
  const modelsByProvider = data.catalog.data?.modelsByProvider ?? {};
  const filteredProviders = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return providers.filter((provider) => {
      if (!providerMatchesScope(provider, scope, activeOrganizationId)) return false;
      if (!keyword) return true;
      const models = modelsByProvider[getProviderKey(provider)] ?? [];
      return [provider.id, provider.name, provider.protocol, ...models.flatMap((model) => [model.id, model.name])]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [activeOrganizationId, modelsByProvider, providers, query, scope]);

  const selectedProvider =
    filteredProviders.find((provider) => getProviderKey(provider) === selectedKey) ?? filteredProviders[0] ?? null;
  useEffect(() => {
    if (selectedProvider && getProviderKey(selectedProvider) !== selectedKey) {
      setSelectedKey(getProviderKey(selectedProvider));
    }
  }, [selectedKey, selectedProvider]);

  if (data.catalog.loading) return <ModelsLoading />;
  if (data.catalog.error && !data.catalog.data) {
    // 页面级失败态与目录态用同一套壳：原来这里是一段只有自己的背景与内边距的裸 div，
    // 与 AppPage（`bg-surface-0` + 页面留白）对不齐；现在统一走 AppPage + EmptyState。
    return (
      <AppPage>
        <EmptyState
          icon={<AlertTriangle />}
          title={t("loadState.title")}
          description={data.catalog.error.message}
          tone="danger"
          role="alert"
          className="flex min-h-96 flex-col items-center justify-center"
          action={{ label: t("actions.retry"), onClick: data.catalog.refresh, icon: <RefreshCw /> }}
        />
      </AppPage>
    );
  }

  const selectedModels = selectedProvider ? (modelsByProvider[getProviderKey(selectedProvider)] ?? []) : [];
  return (
    <>
      <AgentModelsCatalog
        providers={filteredProviders}
        allProviders={providers}
        modelsByProvider={modelsByProvider}
        selectedProvider={selectedProvider}
        activeOrganizationId={activeOrganizationId}
        query={query}
        scope={scope}
        detailFailures={data.catalog.data?.detailFailures ?? []}
        testing={data.testModel.loading}
        discovering={data.discoverModels.loading}
        toggling={data.togglePublic.loading}
        modelTest={data.modelTest}
        onQueryChange={setQuery}
        onScopeChange={setScope}
        onSelectProvider={(provider) => setSelectedKey(getProviderKey(provider))}
        onCreateProvider={() => setProviderDialog({ mode: "create" })}
        onEditProvider={(provider) => setProviderDialog({ mode: "edit", provider })}
        onViewProvider={(provider) => setProviderDialog({ mode: "view", provider })}
        onDeleteProvider={setDeleteProvider}
        onTogglePublic={(provider, value) => data.togglePublic.run(provider, value)}
        onDiscoverModels={(provider) =>
          data.discoverModels.run(getProviderKey(provider), modelsByProvider[getProviderKey(provider)] ?? [])
        }
        onCreateModel={(provider) => setModelDialog({ mode: "create", providerKey: getProviderKey(provider) })}
        onEditModel={(provider, model) =>
          setModelDialog({ mode: "edit", providerKey: getProviderKey(provider), model })
        }
        onViewModel={(provider, model) =>
          setModelDialog({ mode: "view", providerKey: getProviderKey(provider), model })
        }
        onDeleteModel={(provider, model) => setDeleteModel({ providerKey: getProviderKey(provider), model })}
        onTestModel={(provider, model) => data.testModel.run(getProviderKey(provider), model.id)}
        onViewGatewayUsage={(provider) =>
          void navigate({
            to: "/agent/model-gateway-usage/$providerId",
            params: { providerId: provider.providerId },
          })
        }
        onRetry={data.catalog.refresh}
      />
      <ProviderEditorDialog
        target={providerDialog}
        providers={providers}
        saving={data.saveProvider.loading}
        onClose={() => setProviderDialog(null)}
        onSave={data.saveProvider.runAsync}
      />
      <ModelEditorDialog
        target={modelDialog}
        saving={data.saveModel.loading}
        onClose={() => setModelDialog(null)}
        onSave={data.saveModel.runAsync}
      />
      <DiscoveryDialog
        state={data.discovery}
        adding={data.addDiscoveredModel.loading}
        onClose={() => data.setDiscovery(null)}
        onAdd={data.addDiscoveredModel.run}
      />
      <ModelDeleteDialogs
        provider={deleteProvider}
        model={deleteModel}
        deleting={data.deleteProvider.loading || data.deleteModel.loading}
        onCloseProvider={() => setDeleteProvider(null)}
        onCloseModel={() => setDeleteModel(null)}
        onDeleteProvider={async () => {
          if (!deleteProvider) return;
          try {
            await data.deleteProvider.runAsync(getProviderKey(deleteProvider));
            setDeleteProvider(null);
          } catch {
            /* 删除失败由控制器展示，保留确认框便于重试。 */
          }
        }}
        onDeleteModel={async () => {
          if (!deleteModel) return;
          try {
            await data.deleteModel.runAsync(deleteModel.providerKey, deleteModel.model.id);
            setDeleteModel(null);
          } catch {
            /* 删除失败由控制器展示，保留确认框便于重试。 */
          }
        }}
      />
      <span className="sr-only" aria-live="polite">
        {selectedProvider
          ? t("selectionAnnouncement", { provider: selectedProvider.name, count: selectedModels.length })
          : ""}
      </span>
    </>
  );
}

function ModelsLoading() {
  return (
    <div className="agent-models-loading" aria-busy="true">
      <div>
        <Skeleton className="h-7 w-36" />
        <Skeleton className="mt-2 h-4 w-80" />
      </div>
      <Skeleton className="h-10 w-full" />
      <div className="models-loading-grid grid min-h-140 overflow-hidden rounded-lg">
        <Skeleton className="h-full rounded-none" />
        <Skeleton className="h-full rounded-none bg-white" />
      </div>
    </div>
  );
}
