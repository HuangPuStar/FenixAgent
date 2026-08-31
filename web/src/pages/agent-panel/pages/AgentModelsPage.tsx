import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProviderInfo, ProviderModel } from "../../../types/config";
import { AgentModelsCatalog } from "./agent-models-catalog";
import { useAgentModelsData } from "./agent-models-data";
import { DiscoveryDialog, ModelDeleteDialogs, ModelEditorDialog, ProviderEditorDialog } from "./agent-models-dialogs";
import type { ModelDialogTarget, ProviderDialogTarget } from "./agent-models-types";
import { getProviderKey, getProviderScope, type ProviderScope } from "./agent-models-utils";
import "./agent-models.css";
import "./agent-models-dialogs.css";
import "./agent-models-states.css";

export function AgentModelsPage() {
  const { t } = useTranslation("models");
  const navigate = useNavigate();
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
      if (scope !== "all" && getProviderScope(provider) !== scope) return false;
      if (!keyword) return true;
      const models = modelsByProvider[getProviderKey(provider)] ?? [];
      return [provider.id, provider.name, provider.protocol, ...models.flatMap((model) => [model.id, model.name])]
        .join(" ")
        .toLowerCase()
        .includes(keyword);
    });
  }, [modelsByProvider, providers, query, scope]);

  const selectedProvider =
    filteredProviders.find((provider) => getProviderKey(provider) === selectedKey) ?? filteredProviders[0] ?? null;
  useEffect(() => {
    if (selectedProvider && getProviderKey(selectedProvider) !== selectedKey) {
      setSelectedKey(getProviderKey(selectedProvider));
    }
  }, [selectedKey, selectedProvider]);

  if (data.catalog.loading) return <ModelsLoading />;
  if (data.catalog.error && !data.catalog.data) {
    return (
      <div className="agent-models-load-error" role="alert">
        <AlertTriangle />
        <h1>{t("loadState.title")}</h1>
        <p>{data.catalog.error.message}</p>
        <Button onClick={data.catalog.refresh}>
          <RefreshCw />
          {t("actions.retry")}
        </Button>
      </div>
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
        onViewProvider={(provider) => {
          if (provider.kind === "gateway") {
            void navigate({
              to: "/agent/model-gateway-usage/$providerId",
              params: { providerId: provider.providerId },
            });
            return;
          }
          setProviderDialog({ mode: "view", provider });
        }}
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
      <div className="grid min-h-[560px] grid-cols-[238px_1fr] overflow-hidden rounded-[10px]">
        <Skeleton className="h-full rounded-none" />
        <Skeleton className="h-full rounded-none bg-white" />
      </div>
    </div>
  );
}
