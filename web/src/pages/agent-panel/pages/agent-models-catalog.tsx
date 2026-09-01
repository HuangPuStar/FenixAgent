import {
  CheckCircle2,
  ChevronRight,
  CircleOff,
  Eye,
  FileSearch,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModelIcon } from "@/components/model-icon/ModelIcon";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AppHeader } from "@/src/components/layout/app-header";
import { AppPage } from "@/src/components/layout/app-page";
import { NS } from "@/src/i18n";
import type { ProviderInfo, ProviderModel } from "../../../types/config";
import { AgentMasterDetailHeader, AgentMasterDetailWorkspace } from "../shared/agent-master-detail-workspace";
import type { ModelTestState } from "./agent-models-types";
import {
  canWriteProvider,
  getProviderColor,
  getProviderIconModelId,
  getProviderKey,
  getProviderScope,
  type ProviderScope,
} from "./agent-models-utils";

const SCOPES: ProviderScope[] = ["all", "organization", "shared"];

interface ModelsCatalogProps {
  providers: ProviderInfo[];
  allProviders: ProviderInfo[];
  modelsByProvider: Record<string, ProviderModel[]>;
  selectedProvider: ProviderInfo | null;
  query: string;
  scope: ProviderScope;
  detailFailures: string[];
  testing: boolean;
  discovering: boolean;
  toggling: boolean;
  modelTest: ModelTestState | null;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: ProviderScope) => void;
  onSelectProvider: (provider: ProviderInfo) => void;
  onCreateProvider: () => void;
  onEditProvider: (provider: ProviderInfo) => void;
  onViewProvider: (provider: ProviderInfo) => void;
  onDeleteProvider: (provider: ProviderInfo) => void;
  onTogglePublic: (provider: ProviderInfo, value: boolean) => void;
  onDiscoverModels: (provider: ProviderInfo) => void;
  onCreateModel: (provider: ProviderInfo) => void;
  onEditModel: (provider: ProviderInfo, model: ProviderModel) => void;
  onViewModel: (provider: ProviderInfo, model: ProviderModel) => void;
  onDeleteModel: (provider: ProviderInfo, model: ProviderModel) => void;
  onTestModel: (provider: ProviderInfo, model: ProviderModel) => void;
  onViewGatewayUsage: (provider: ProviderInfo) => void;
  onRetry: () => void;
}

export function AgentModelsCatalog(props: ModelsCatalogProps) {
  const { t } = useTranslation(NS.MODELS);
  const counts = SCOPES.reduce<Record<ProviderScope, number>>(
    (result, scope) => {
      result[scope] =
        scope === "all"
          ? props.allProviders.length
          : props.allProviders.filter((item) => getProviderScope(item) === scope).length;
      return result;
    },
    { all: 0, organization: 0, shared: 0 },
  );
  return (
    <AppPage className="agent-models-page">
      <AppHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onClick={props.onCreateProvider}>
            <Plus />
            {t("createButton")}
          </Button>
        }
      />
      <div className="models-search-toolbar">
        <label className="models-search-field">
          <Search />
          <span className="sr-only">{t("searchLabel")}</span>
          <input
            value={props.query}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={t("searchPlaceholder")}
          />
        </label>
        <div className="models-scope-filter" role="group" aria-label={t("scope.label")}>
          {SCOPES.map((item) => (
            <button
              key={item}
              type="button"
              aria-pressed={props.scope === item}
              onClick={() => props.onScopeChange(item)}
            >
              {t(`scope.${item}`)} <small>{counts[item]}</small>
            </button>
          ))}
        </div>
      </div>
      {props.detailFailures.length > 0 && (
        <div className="models-partial-error" role="alert">
          <span>{t("partialLoadError", { count: props.detailFailures.length })}</span>
          <Button variant="ghost" size="sm" onClick={props.onRetry}>
            <RefreshCw />
            {t("actions.retry")}
          </Button>
        </div>
      )}
      <AgentMasterDetailWorkspace
        detailHeader={
          props.selectedProvider ? <ProviderDetail {...props} provider={props.selectedProvider} headerOnly /> : null
        }
        index={
          <ProviderIndex
            providers={props.providers}
            modelsByProvider={props.modelsByProvider}
            selected={props.selectedProvider}
            onSelect={props.onSelectProvider}
          />
        }
      >
        {props.selectedProvider ? (
          <ProviderDetail {...props} provider={props.selectedProvider} />
        ) : (
          <CatalogEmpty query={props.query} />
        )}
      </AgentMasterDetailWorkspace>
    </AppPage>
  );
}

function ProviderIndex({
  providers,
  modelsByProvider,
  selected,
  onSelect,
}: {
  providers: ProviderInfo[];
  modelsByProvider: Record<string, ProviderModel[]>;
  selected: ProviderInfo | null;
  onSelect: (provider: ProviderInfo) => void;
}) {
  const { t } = useTranslation(NS.MODELS);
  return (
    <aside className="models-provider-index">
      <header>
        <div>
          <strong>{t("providerIndex.title")}</strong>
          <span>{providers.length}</span>
        </div>
        <small>{t("providerIndex.description")}</small>
      </header>
      {providers.length ? (
        <nav aria-label={t("providerIndex.title")}>
          {providers.map((provider) => {
            const key = getProviderKey(provider);
            const iconModelId = getProviderIconModelId(provider, modelsByProvider[key] ?? []);
            const active = key === (selected ? getProviderKey(selected) : null);
            const organizationName = provider.resourceAccess?.sourceOrganizationName ?? t("scope.organization");
            const publiclyReadable =
              provider.resourceAccess?.ownership === "external" || provider.resourceAccess?.publicReadable === true;
            return (
              <button
                type="button"
                key={key}
                className={active ? "is-selected" : ""}
                aria-current={active ? "page" : undefined}
                onClick={() => onSelect(provider)}
              >
                <span className="models-provider-brand [--ant-color-text-description:currentColor] text-secondary">
                  <ModelIcon modelId={iconModelId} size={18} />
                </span>
                <span className="models-provider-copy">
                  <strong>{provider.name || provider.id}</strong>
                  <small title={organizationName}>
                    {organizationName} · {t("providerIndex.models", { count: provider.modelCount })}
                  </small>
                </span>
                {publiclyReadable ? <span className="models-provider-scope">{t("scope.shared")}</span> : null}
                <ChevronRight className="models-provider-arrow" />
              </button>
            );
          })}
        </nav>
      ) : (
        <div className="models-provider-empty">
          <FileSearch />
          <span>{t("providerIndex.empty")}</span>
        </div>
      )}
    </aside>
  );
}

function ProviderDetail(props: ModelsCatalogProps & { provider: ProviderInfo; headerOnly?: boolean }) {
  const { t } = useTranslation(NS.MODELS);
  const provider = props.provider;
  const key = getProviderKey(provider);
  const models = props.modelsByProvider[key] ?? [];
  const iconModelId = getProviderIconModelId(provider, models);
  const writable = canWriteProvider(provider);
  const publiclyReadable =
    provider.resourceAccess?.ownership === "external" || provider.resourceAccess?.publicReadable === true;
  const color = getProviderColor(provider.id);
  const header = (
    <div style={{ "--provider-color": color } as CSSProperties}>
      <AgentMasterDetailHeader className="models-provider-detail__header">
        <div className="models-provider-identity">
          <span className="models-provider-detail-brand [--ant-color-text-description:currentColor]">
            <ModelIcon modelId={iconModelId} size={25} />
          </span>
          <div>
            <div className="models-provider-meta">
              <span>{t(`protocolOptions.${provider.protocol}`)}</span>
              {provider.kind === "gateway" && <span>{t("gateway.tag")}</span>}
              <code>{provider.id}</code>
            </div>
            <h2>{provider.name || provider.id}</h2>
            <div className="models-provider-organization">
              <small>
                {provider.resourceAccess?.sourceOrganizationName ?? t("scope.organization")} ·{" "}
                {t("providerIndex.models", { count: models.length })}
              </small>
              {publiclyReadable ? <span className="models-provider-public-badge">{t("scope.shared")}</span> : null}
            </div>
          </div>
        </div>
        <div className="models-provider-controls">
          {provider.kind === "gateway" && (
            <button type="button" onClick={() => props.onViewGatewayUsage(provider)}>
              {t("gateway.myUsage")}
            </button>
          )}
          {writable ? (
            <>
              <button type="button" onClick={() => props.onEditProvider(provider)}>
                <Pencil /> {t("actions.edit")}
              </button>
              <button type="button" className="is-danger" onClick={() => props.onDeleteProvider(provider)}>
                <Trash2 /> {t("actions.delete")}
              </button>
            </>
          ) : (
            <button type="button" onClick={() => props.onViewProvider(provider)}>
              <Eye /> {t("actions.view")}
            </button>
          )}
        </div>
      </AgentMasterDetailHeader>
    </div>
  );
  if (props.headerOnly) return header;
  return (
    <article className="models-provider-detail" style={{ "--provider-color": color } as CSSProperties}>
      <div className="models-provider-connection">
        <div>
          <Server />
          <small>{t("connection.endpoint")}</small>
          <code title={provider.baseURL ?? undefined}>{provider.baseURL ?? t("connection.defaultEndpoint")}</code>
        </div>
        <div>
          <KeyRound />
          <small>{t("connection.credential")}</small>
          <code>{provider.keyHint ?? t("connection.managedCredential")}</code>
        </div>
        <label className="models-provider-visibility">
          <span>
            <strong>{t("connection.shared")}</strong>
            <small>{t("connection.sharedDescription")}</small>
          </span>
          <Switch
            checked={Boolean(provider.resourceAccess?.publicReadable)}
            disabled={!writable || provider.resourceAccess?.manageable !== true || props.toggling}
            onCheckedChange={(value) => props.onTogglePublic(provider, value)}
          />
        </label>
      </div>
      <section className="models-model-catalog">
        <header>
          <div>
            <h3>{t("modelsSection.title")}</h3>
            <small>{t("modelsSection.description", { count: models.length })}</small>
          </div>
          {writable && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                disabled={props.discovering}
                onClick={() => props.onDiscoverModels(provider)}
              >
                {props.discovering ? <LoaderCircle className="animate-spin" /> : <Search />}
                {t("form.fetchModels")}
              </Button>
              <Button size="sm" onClick={() => props.onCreateModel(provider)}>
                <Plus />
                {t("modelSubrow.addButtonLabel")}
              </Button>
            </div>
          )}
        </header>
        {models.length ? (
          <div className="models-model-list">
            {models.map((model) => (
              <ModelRow
                key={model.id}
                provider={provider}
                model={model}
                test={props.modelTest?.key === `${key}:${model.id}` ? props.modelTest : null}
                testing={props.testing}
                writable={writable}
                onTest={props.onTestModel}
                onEdit={props.onEditModel}
                onView={props.onViewModel}
                onDelete={props.onDeleteModel}
              />
            ))}
          </div>
        ) : (
          <div className="models-model-empty">
            <CircleOff />
            <strong>{t("modelSubrow.emptyTitle")}</strong>
            <span>{writable ? t("modelSubrow.emptyMessage") : t("modelSubrow.emptyReadOnly")}</span>
          </div>
        )}
      </section>
    </article>
  );
}

function ModelRow({
  provider,
  model,
  test,
  testing,
  writable,
  onTest,
  onEdit,
  onView,
  onDelete,
}: {
  provider: ProviderInfo;
  model: ProviderModel;
  test: ModelTestState | null;
  testing: boolean;
  writable: boolean;
  onTest: (provider: ProviderInfo, model: ProviderModel) => void;
  onEdit: (provider: ProviderInfo, model: ProviderModel) => void;
  onView: (provider: ProviderInfo, model: ProviderModel) => void;
  onDelete: (provider: ProviderInfo, model: ProviderModel) => void;
}) {
  const { t } = useTranslation(NS.MODELS);
  return (
    <div className="models-model-row">
      <div className="models-model-summary">
        <span className="models-model-icon [--ant-color-text-description:currentColor]">
          <ModelIcon modelId={model.id} size={17} />
        </span>
        <span className="models-model-identity">
          <strong>{model.name || model.id}</strong>
          <code>{model.id}</code>
        </span>
      </div>
      <div className="models-model-actions">
        {test && (
          <span className={`models-model-test is-${test.status}`} title={test.detail}>
            {test.status === "running" ? (
              <LoaderCircle className="animate-spin" />
            ) : test.status === "success" ? (
              <CheckCircle2 />
            ) : (
              <XCircle />
            )}
            {t(`testStatus.${test.status}`)}
          </span>
        )}
        {writable ? (
          <>
            <button type="button" disabled={testing} onClick={() => onTest(provider, model)}>
              {t("actions.test")}
            </button>
            <button type="button" onClick={() => onEdit(provider, model)}>
              {t("actions.edit")}
            </button>
            <button type="button" className="is-danger" onClick={() => onDelete(provider, model)}>
              {t("actions.delete")}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => onView(provider, model)}>
            {t("actions.view")}
          </button>
        )}
      </div>
    </div>
  );
}

function CatalogEmpty({ query }: { query: string }) {
  const { t } = useTranslation(NS.MODELS);
  return (
    <div className="models-catalog-empty">
      <FileSearch />
      <strong>{query ? t("empty.filteredTitle") : t("empty.title")}</strong>
      <span>{query ? t("empty.filteredDescription") : t("empty.description")}</span>
    </div>
  );
}
