import {
  Bot,
  BrainCircuit,
  Check,
  ChevronRight,
  CircleX,
  Clock3,
  FileSearch,
  Globe2,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { ResourceScopeFilter } from "../components/resource-scope-filter";
import { PageHeader, PrimaryButton, SearchToolbar, Toast, ToolbarSummary } from "../components/ui";
import { type OwnedResourceScope, RESOURCE_SCOPES, type ResourceScope } from "../lib/resource-scope";
import { ProviderBrandIcon, SandboxModelIcon } from "./models/model-brand-icon";
import { ModelDialogs, type ModelDraft, type ProviderDraft } from "./models/model-dialogs";
import {
  createDiscoveredModel,
  INITIAL_PROVIDERS,
  type ModelDialogState,
  type SandboxModel,
  type SandboxProvider,
} from "./models/model-sandbox-data";

export function ModelsPage() {
  const [providers, setProviders] = useState(() => INITIAL_PROVIDERS);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ResourceScope>("全部");
  const [selectedProviderId, setSelectedProviderId] = useState(INITIAL_PROVIDERS[0]?.id ?? "");
  const [dialog, setDialog] = useState<ModelDialogState | null>(null);
  const [toast, setToast] = useState("");
  const [testState, setTestState] = useState<{ key: string; status: "running" | "success" | "error" } | null>(null);

  const visibleProviders = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return providers.filter(
      (provider) =>
        (scope === "全部" || provider.scope === scope) &&
        (!keyword ||
          [provider.name, provider.id, provider.protocol, ...provider.models.flatMap((model) => [model.name, model.id])]
            .join(" ")
            .toLowerCase()
            .includes(keyword)),
    );
  }, [providers, query, scope]);

  useEffect(() => {
    if (testState?.status !== "running") return;
    const timer = window.setTimeout(
      () =>
        setTestState((current) =>
          current ? { ...current, status: current.key.includes("deepseek") ? "error" : "success" } : null,
        ),
      850,
    );
    return () => window.clearTimeout(timer);
  }, [testState]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const closeWithToast = (text: string) => {
    setDialog(null);
    setToast(text);
  };

  const updateProvider = (providerId: string, update: (provider: SandboxProvider) => SandboxProvider) => {
    setProviders((current) => current.map((provider) => (provider.id === providerId ? update(provider) : provider)));
  };

  const saveProvider = (providerDraft: ProviderDraft, selectedModels: string[], provider?: SandboxProvider) => {
    if (provider) {
      updateProvider(provider.id, (current) => ({
        ...current,
        name: providerDraft.name || current.name,
        protocol: providerDraft.protocol,
        endpoint: providerDraft.endpoint || current.endpoint,
        updatedAt: "刚刚",
      }));
      closeWithToast("服务商已更新（Mock）");
      return;
    }
    const id = providerDraft.id.trim() || `provider-${providers.length + 1}`;
    const discoveredModels = selectedModels.map(createDiscoveredModel);
    setProviders((current) => [
      ...current,
      {
        id,
        name: providerDraft.name.trim() || "新服务商",
        protocol: providerDraft.protocol,
        endpoint: providerDraft.endpoint.trim() || "https://api.example.com/v1",
        keyHint: "••••••••",
        publicRead: false,
        version: 1,
        color: "#2764e7",
        updatedAt: "刚刚",
        models: discoveredModels,
        scope: "个人",
      },
    ]);
    closeWithToast("服务商已创建（Mock）");
  };

  const saveModel = (modelDraft: ModelDraft, provider: SandboxProvider, model?: SandboxModel) => {
    const nextModel: SandboxModel = {
      id: modelDraft.id.trim() || `model-${provider.models.length + 1}`,
      name: modelDraft.name.trim() || modelDraft.id.trim() || "新模型",
      context: modelDraft.context ? `${Number(modelDraft.context) / 1_000}K` : "128K",
      thinking: modelDraft.thinking ? `${modelDraft.thinkingBudget || "可配置"} 思考预算` : undefined,
      cost: { input: Number(modelDraft.inputCost) || 0, output: Number(modelDraft.outputCost) || 0 },
    };
    updateProvider(provider.id, (current) => ({
      ...current,
      updatedAt: "刚刚",
      models: model
        ? current.models.map((item) => (item.id === model.id ? nextModel : item))
        : [...current.models, nextModel],
    }));
    closeWithToast(model ? "模型已更新（Mock）" : "模型已添加（Mock）");
  };

  const addDiscoveredModels = (provider: SandboxProvider, selectedModels: string[]) => {
    updateProvider(provider.id, (current) => {
      const existingIds = new Set(current.models.map((model) => model.id));
      const additions = selectedModels.filter((id) => !existingIds.has(id)).map(createDiscoveredModel);
      return { ...current, updatedAt: "刚刚", models: [...current.models, ...additions] };
    });
    closeWithToast(`已添加 ${selectedModels.length} 个模型（Mock）`);
  };

  const confirmResourceAction = (action: Extract<ModelDialogState, { kind: "delete-provider" | "delete-model" }>) => {
    if (action.kind === "delete-provider") {
      setProviders((current) => current.filter((provider) => provider.id !== action.provider.id));
      closeWithToast("服务商已删除（Mock）");
    } else {
      updateProvider(action.provider.id, (current) => ({
        ...current,
        models: current.models.filter((model) => model.id !== action.model.id),
        updatedAt: "刚刚",
      }));
      closeWithToast("模型已删除（Mock）");
    }
  };

  const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0);
  const visibleModelCount = visibleProviders.reduce((sum, provider) => sum + provider.models.length, 0);
  const scopeCounts: Record<ResourceScope, number> = {
    全部: totalModels,
    个人: providers
      .filter((provider) => provider.scope === "个人")
      .reduce((sum, provider) => sum + provider.models.length, 0),
    本组织: providers
      .filter((provider) => provider.scope === "本组织")
      .reduce((sum, provider) => sum + provider.models.length, 0),
    平台: providers
      .filter((provider) => provider.scope === "平台")
      .reduce((sum, provider) => sum + provider.models.length, 0),
  };

  const selectedProvider =
    visibleProviders.find((provider) => provider.id === selectedProviderId) ?? visibleProviders[0];
  return (
    <div className="page-frame models-page">
      <PageHeader title="模型库" description="连接服务商，描述模型能力，并生成可锁定的 Agent 引用。">
        <PrimaryButton onClick={() => setDialog({ kind: "provider" })}>新建服务商</PrimaryButton>
      </PageHeader>

      <SearchToolbar
        value={query}
        onChange={setQuery}
        placeholder="搜索服务商、模型或协议"
        className="models-commandbar"
      >
        <ResourceScopeFilter value={scope} onChange={setScope} counts={scopeCounts} options={RESOURCE_SCOPES} />
        <ToolbarSummary>
          <span>
            <strong>{providers.length}</strong> 服务商
          </span>
          <span>
            <strong>{visibleModelCount}</strong> 当前模型
          </span>
          <span>
            <Clock3 />
            今天 09:42 更新
          </span>
        </ToolbarSummary>
      </SearchToolbar>

      <section className="models-workspace">
        <aside className="provider-index">
          <header>
            <div>
              <strong>服务商</strong>
              <span>{visibleProviders.length}</span>
            </div>
            <small>连接与凭证</small>
          </header>

          {visibleProviders.length === 0 ? (
            <div className="provider-index__empty">
              <Search />
              <span>没有匹配服务商</span>
            </div>
          ) : (
            <nav aria-label="服务商列表">
              {visibleProviders.map((provider) => {
                const selected = provider.id === selectedProvider?.id;
                return (
                  <button
                    type="button"
                    className={selected ? "is-selected" : ""}
                    aria-current={selected ? "page" : undefined}
                    key={provider.id}
                    onClick={() => setSelectedProviderId(provider.id)}
                  >
                    <span className="provider-index__brand">
                      <ProviderBrandIcon providerId={provider.id} providerName={provider.name} />
                    </span>
                    <span className="provider-index__copy">
                      <strong>{provider.name}</strong>
                      <small>
                        {provider.protocol} · {provider.models.length} 个模型
                      </small>
                    </span>
                    <span
                      className={`provider-index__scope is-${provider.scope === "个人" ? "personal" : provider.scope === "本组织" ? "org" : "platform"}`}
                    >
                      {provider.scope}
                    </span>
                    <ChevronRight className="provider-index__arrow" />
                  </button>
                );
              })}
            </nav>
          )}
        </aside>

        {selectedProvider ? (
          <article className="provider-detail" style={{ "--provider-color": selectedProvider.color } as CSSProperties}>
            <header className="provider-detail__header">
              <div className="provider-detail__identity">
                <span className="provider-detail__brand">
                  <ProviderBrandIcon providerId={selectedProvider.id} providerName={selectedProvider.name} size={24} />
                </span>
                <div>
                  <div className="provider-detail__meta">
                    <span>{selectedProvider.protocol}</span>
                    <code>{selectedProvider.id}</code>
                  </div>
                  <h3>{selectedProvider.name}</h3>
                  <small>
                    {selectedProvider.models.length} 个模型 · 更新于 {selectedProvider.updatedAt}
                  </small>
                </div>
              </div>
              <div className="provider-detail__controls">
                <select
                  className="provider-scope-select"
                  value={selectedProvider.scope}
                  aria-label="模型归属范围"
                  onChange={(event) =>
                    updateProvider(selectedProvider.id, (current) => ({
                      ...current,
                      scope: event.target.value as OwnedResourceScope,
                      updatedAt: "刚刚",
                    }))
                  }
                >
                  <option value="个人">个人</option>
                  <option value="本组织">本组织</option>
                  <option value="平台">平台</option>
                </select>
                <button type="button" onClick={() => setDialog({ kind: "provider", provider: selectedProvider })}>
                  <Pencil />
                  编辑连接
                </button>
                <button
                  type="button"
                  aria-label={`删除 ${selectedProvider.name}`}
                  onClick={() => setDialog({ kind: "delete-provider", provider: selectedProvider })}
                >
                  <Trash2 />
                </button>
              </div>
            </header>

            <section className="provider-connection" aria-label="连接信息">
              <div>
                <Globe2 />
                <small>Endpoint</small>
                <code>{selectedProvider.endpoint}</code>
              </div>
              <div>
                <KeyRound />
                <small>密钥引用</small>
                <code>{selectedProvider.keyHint}</code>
              </div>
            </section>

            <section className="model-catalog">
              <header>
                <div>
                  <h4>模型</h4>
                  <small>{selectedProvider.models.length} 个已配置模型</small>
                </div>
                <div>
                  <button type="button" onClick={() => setDialog({ kind: "discover", provider: selectedProvider })}>
                    <FileSearch />
                    从服务商发现
                  </button>
                  <button
                    type="button"
                    className="is-primary"
                    onClick={() => setDialog({ kind: "model", provider: selectedProvider })}
                  >
                    <Plus />
                    添加模型
                  </button>
                </div>
              </header>

              <div className="model-list">
                {selectedProvider.models.map((model) => {
                  const testKey = `${selectedProvider.id}:${model.id}`;
                  const currentTest = testState?.key === testKey ? testState.status : null;
                  return (
                    <div className="model-row" key={model.id}>
                      <div className="model-row__summary">
                        <span className="model-row__icon">
                          <SandboxModelIcon modelId={model.id} />
                        </span>
                        <div className="model-row__identity">
                          <strong>{model.name}</strong>
                          <code>{model.id}</code>
                        </div>
                      </div>
                      <div className="model-row__traits">
                        <span className={model.thinking ? "supports-thinking" : "no-thinking"}>
                          <BrainCircuit />
                          {model.thinking ? "支持思考" : "无思考"}
                        </span>
                      </div>
                      <span
                        className={`model-row__scope is-${selectedProvider.scope === "个人" ? "personal" : selectedProvider.scope === "本组织" ? "org" : "platform"}`}
                      >
                        {selectedProvider.scope}
                      </span>
                      <div className="model-row__actions">
                        <button
                          type="button"
                          data-state={currentTest ?? undefined}
                          onClick={() => setTestState({ key: testKey, status: "running" })}
                        >
                          {currentTest === "running" ? (
                            <LoaderCircle className="is-spinning" />
                          ) : currentTest === "success" ? (
                            <Check />
                          ) : currentTest === "error" ? (
                            <CircleX />
                          ) : (
                            <Bot />
                          )}
                          {currentTest === "running"
                            ? "测试中"
                            : currentTest === "success"
                              ? "已通过"
                              : currentTest === "error"
                                ? "失败·重试"
                                : "测试"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDialog({ kind: "model", provider: selectedProvider, model })}
                        >
                          <Pencil />
                          编辑
                        </button>
                        <button
                          type="button"
                          aria-label={`删除 ${model.name}`}
                          onClick={() => setDialog({ kind: "delete-model", provider: selectedProvider, model })}
                        >
                          <Trash2 />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </article>
        ) : (
          <section className="models-empty">
            <Search />
            <strong>没有匹配结果</strong>
            <span>尝试搜索服务商名称、模型 ID 或协议。</span>
          </section>
        )}
      </section>

      {dialog && (
        <ModelDialogs
          key={`${dialog.kind}:${"provider" in dialog && dialog.provider ? dialog.provider.id : "new"}:${dialog.kind === "model" && dialog.model ? dialog.model.id : ""}`}
          dialog={dialog}
          onClose={() => setDialog(null)}
          onSaveProvider={saveProvider}
          onSaveModel={saveModel}
          onAddDiscovered={addDiscoveredModels}
          onConfirmResource={confirmResourceAction}
        />
      )}
      {toast && <Toast text={toast} />}
    </div>
  );
}
