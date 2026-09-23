import {
  AgentCatalogIndex,
  AgentCatalogIndexArrow,
  AgentCatalogIndexCopy,
  AgentCatalogIndexIcon,
  AgentCatalogIndexItem,
  AgentCatalogIndexMeta,
  AgentCatalogIndexNav,
} from "@fenix/ui-components/components/agent-catalog-index";
import {
  AgentMasterDetailHeader,
  AgentMasterDetailWorkspace,
} from "@fenix/ui-components/components/agent-master-detail-workspace";
import { EMPTY_STATE_FILL_CLASS, EmptyState } from "@fenix/ui-components/config/EmptyState";
import { ScopeFilterBar, type ScopeFilterOption } from "@fenix/ui-components/config/ScopeFilterBar";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Button } from "@fenix/ui-components/ui/button";
import { Switch } from "@fenix/ui-components/ui/switch";
import type { ProviderInfo, ProviderModel } from "@fenix/web-runtime/types/config";
import {
  CheckCircle2,
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
import { ModelIcon } from "../../../components/model-icon/ModelIcon";
import { MODELS_NS } from "../../../i18n/namespace";
import { isExternalProvider, isPublicProvider } from "../../../lib/provider-resource-access";
import type { ModelTestState } from "./agent-models-types";
import {
  canWriteProvider,
  getProviderColor,
  getProviderIconModelId,
  getProviderKey,
  type ProviderScope,
  providerMatchesScope,
} from "./agent-models-utils";

const SCOPES: ProviderScope[] = ["all", "organization", "public"];

interface ModelsCatalogProps {
  providers: ProviderInfo[];
  allProviders: ProviderInfo[];
  modelsByProvider: Record<string, ProviderModel[]>;
  selectedProvider: ProviderInfo | null;
  /** 当前组织 id；判定 Provider 是否为跨组织共享来源，缺失时按本组织视角处理。 */
  activeOrganizationId?: string;
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
  const { t } = useTranslation(MODELS_NS);
  const counts = SCOPES.reduce<Record<ProviderScope, number>>(
    (result, scope) => {
      result[scope] =
        scope === "all"
          ? props.allProviders.length
          : props.allProviders.filter((item) => providerMatchesScope(item, scope, props.activeOrganizationId)).length;
      return result;
    },
    { all: 0, organization: 0, public: 0 },
  );
  // 作用域清单与展示文案归本页所有（组件只负责渲染），`satisfies` 同时校验形状。
  const scopeOptions = SCOPES.map((item) => ({
    value: item,
    label: t(`scope.${item}`),
    count: counts[item],
  })) satisfies readonly ScopeFilterOption[];
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
      <ScopeFilterBar
        query={props.query}
        onQueryChange={props.onQueryChange}
        placeholder={t("searchPlaceholder")}
        searchLabel={t("searchLabel")}
        // 作用域清单与展示文案归本页所有（组件只负责渲染）；`SCOPES` 已带 `ProviderScope` 类型，
        // 回调处保留字面量类型而不把 `string` 漏进业务状态。
        scopes={scopeOptions}
        scope={props.scope}
        onScopeChange={(value) => props.onScopeChange(value as ProviderScope)}
        scopeGroupLabel={t("scope.label")}
      />
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
            activeOrganizationId={props.activeOrganizationId}
            onSelect={props.onSelectProvider}
          />
        }
      >
        {props.selectedProvider ? (
          <ProviderDetail {...props} provider={props.selectedProvider} />
        ) : (
          // 详情区没有可展示的 Provider：区分「一个都没有」与「筛选后没有匹配」，前者不要误导用户去创建。
          <EmptyState
            icon={<FileSearch />}
            title={props.query ? t("empty.filteredTitle") : t("empty.title")}
            description={props.query ? t("empty.filteredDescription") : t("empty.description")}
            className={EMPTY_STATE_FILL_CLASS}
          />
        )}
      </AgentMasterDetailWorkspace>
    </AppPage>
  );
}

function ProviderIndex({
  providers,
  modelsByProvider,
  selected,
  activeOrganizationId,
  onSelect,
}: {
  providers: ProviderInfo[];
  modelsByProvider: Record<string, ProviderModel[]>;
  selected: ProviderInfo | null;
  activeOrganizationId?: string;
  onSelect: (provider: ProviderInfo) => void;
}) {
  const { t } = useTranslation(MODELS_NS);
  // 目录栏骨架（头部几何、条目四列模板、两行截断、箭头显隐）已下沉到共享构件集，本页只给取值与配色，
  // 对应的本页刻度集中在 `agent-models.css` 的 `.models-provider-index` 一段。
  return (
    <AgentCatalogIndex
      className="models-provider-index"
      title={t("providerIndex.title")}
      count={providers.length}
      description={t("providerIndex.description")}
    >
      {providers.length ? (
        <AgentCatalogIndexNav label={t("providerIndex.title")}>
          {providers.map((provider) => {
            const key = getProviderKey(provider);
            const iconModelId = getProviderIconModelId(provider, modelsByProvider[key] ?? []);
            const active = key === (selected ? getProviderKey(selected) : null);
            const external = isExternalProvider(provider, activeOrganizationId);
            const publiclyReadable = isPublicProvider(provider);
            // `/web` Provider 视图只返回 `scope.organizationId`，跨组织来源因此标注为「组织共享」。
            const organizationName = external ? t("scope.shared") : t("scope.organization");
            return (
              <AgentCatalogIndexItem
                key={key}
                selected={active}
                className={active ? "is-selected" : ""}
                onClick={() => onSelect(provider)}
              >
                <AgentCatalogIndexIcon className="models-provider-brand [--ant-color-text-description:currentColor] text-secondary">
                  <ModelIcon modelId={iconModelId} size={18} />
                </AgentCatalogIndexIcon>
                <AgentCatalogIndexCopy
                  className="models-provider-copy"
                  title={provider.name || provider.id}
                  // 副标题在 238px 列里会被截断，全文仍由 `title` 提供；共享组件的 `<small>` 没有属性插槽，
                  // 所以把它落在内层的 span 上（对外行为与迁移前的 `<small title>` 一致）。
                  subtitle={
                    <span title={organizationName}>
                      {organizationName} · {t("providerIndex.models", { count: provider.modelCount })}
                    </span>
                  }
                />
                <AgentCatalogIndexMeta>
                  {external && !publiclyReadable ? (
                    <span className="models-provider-scope">{t("scope.shared")}</span>
                  ) : null}
                  {publiclyReadable ? <span className="models-provider-scope">{t("scope.public")}</span> : null}
                </AgentCatalogIndexMeta>
                <AgentCatalogIndexArrow className="models-provider-arrow" />
              </AgentCatalogIndexItem>
            );
          })}
        </AgentCatalogIndexNav>
      ) : (
        <EmptyState icon={<FileSearch />} title={t("providerIndex.empty")} className={EMPTY_STATE_FILL_CLASS} />
      )}
    </AgentCatalogIndex>
  );
}

function ProviderDetail(props: ModelsCatalogProps & { provider: ProviderInfo; headerOnly?: boolean }) {
  const { t } = useTranslation(MODELS_NS);
  const provider = props.provider;
  const key = getProviderKey(provider);
  const models = props.modelsByProvider[key] ?? [];
  const iconModelId = getProviderIconModelId(provider, models);
  const writable = canWriteProvider(provider);
  const external = isExternalProvider(provider, props.activeOrganizationId);
  const publiclyReadable = isPublicProvider(provider);
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
                {external ? t("scope.shared") : t("scope.organization")} ·{" "}
                {t("providerIndex.models", { count: models.length })}
              </small>
              {external && !publiclyReadable ? (
                <span className="models-provider-public-badge">{t("scope.shared")}</span>
              ) : null}
              {publiclyReadable ? <span className="models-provider-public-badge">{t("scope.public")}</span> : null}
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
            checked={publiclyReadable}
            // 公开受众变更要求 `update` 动作（`writable` 已包含该判断与 Gateway 只读约束）。
            disabled={!writable || props.toggling}
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
          <EmptyState
            icon={<CircleOff />}
            title={t("modelSubrow.emptyTitle")}
            description={writable ? t("modelSubrow.emptyMessage") : t("modelSubrow.emptyReadOnly")}
            className={EMPTY_STATE_FILL_CLASS}
          />
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
  const { t } = useTranslation(MODELS_NS);
  return (
    <div className="models-model-row">
      <div className="models-model-summary">
        <span className="models-model-icon [--ant-color-text-description:currentColor]">
          <ModelIcon modelId={model.id} size={17} />
        </span>
        <span className="models-model-identity">
          <strong>{model.name || model.id}</strong>
          <code>{model.id}</code>
          {/* 失败原因在列表里直接可见（单行截断 + 徽标 title 给出全文），不是只藏在 tooltip 里。 */}
          {test?.status === "error" && test.detail && <small className="models-model-test-detail">{test.detail}</small>}
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
