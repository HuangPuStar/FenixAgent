import {
  AgentCatalogIndex,
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

/**
 * 供应商 / 模型操作按钮的公共类串——原 `.models-provider-controls button, .models-model-actions button`
 * 的排布、边框与常态取色，以及 `:hover` / `.is-danger:hover` 两条状态配色。
 *
 * 两族按钮的差异只有高度下限（`min-h-7.5` / `min-h-6.75`）与内边距（`px-2` / `px-1.5`）：原先由后写的
 * `.models-model-actions button` 覆盖规则按层叠顺序给出，现在按最终值写在各渲染点。
 * 值映射与 ΔE00 见 `AgentModelsPage.css` 文件头（`--model-muted` → `slate-500`、`--model-blue` →
 * `blue-600`、`--model-blue-soft` → `blue-50`、危险态 `#d84a4a` / `#fff0f0` → `red-500` / `red-50`）。
 */
const ACTION_BTN = "flex items-center gap-1.25 rounded-md border-0 bg-transparent py-0 text-3xs text-slate-500";
/** 常态悬停配色（原 `:hover`）。 */
const ACTION_BTN_HOVER = "hover:bg-blue-50 hover:text-blue-600";
/** 危险态悬停配色（原 `.is-danger:hover`）。 */
const ACTION_BTN_HOVER_DANGER = "hover:bg-red-50 hover:text-red-500";

/**
 * 测试徽标的三态字色——原 `.models-model-test.is-running / .is-success / .is-error` 三条状态规则。
 * 三态互斥，渲染点只挂其中一条（值映射见 `AgentModelsPage.css` 文件头：`--model-blue` → `blue-600`、
 * `#168b68` → `emerald-600`、`#d84a4a` → `red-500`）。
 */
const TEST_STATUS_COLOR: Record<ModelTestState["status"], string> = {
  running: "text-blue-600",
  success: "text-emerald-600",
  error: "text-red-500",
};

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
        <div
          className="models-partial-error flex min-h-9.5 items-center justify-between mb-3 py-0 pl-3.5 pr-2.5 text-xs"
          role="alert"
        >
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
  // 目录栏外观（内边距 / 底色 / 分隔线 / 行距 / 条目三态 / 图标盒 / 字号）全在共享组件
  // `agent-catalog-index.tsx` 的 `className`（伴生 CSS 只剩工具类表达不了的三类：挂不上类名的内层 svg
  // 与尾注 `<span>`、外壳的列模板、窄屏媒体块），本页不再给任何取值——2026-09-23 的裁定是「全部样式统一，
  // 不要观感不统一」。
  return (
    <AgentCatalogIndex
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
                // 选中配色（`aria-[current=page]:…`）与箭头显隐（`group-aria-[current=page]:opacity-100`）都由共享
                // 组件 `className` 的变体类按 `aria-current="page"` 驱动，本页不必自己标类名。
                selected={active}
                onClick={() => onSelect(provider)}
              >
                {/* 品牌图标是彩色 svg，`--ant-color-text-description` 只影响它的单色兜底分支；图标盒的尺寸 /
                    圆角 / 白底是共享组件 `className` 里的 `h-8.5` / `rounded` / `bg-white`。内层 svg 的渲染尺寸
                    由伴生 CSS 的 `.agent-catalog-index-icon svg` 钉在 20px（`calc(var(--spacing) * 5)`，1 档 = 4px）：
                    这里传的 `size={16}` 只写进 svg 的宽高属性，会被那条未分层的结构选择器覆盖，不决定渲染尺寸。 */}
                <AgentCatalogIndexIcon className="[--ant-color-text-description:currentColor]">
                  <ModelIcon modelId={iconModelId} size={16} />
                </AgentCatalogIndexIcon>
                <AgentCatalogIndexCopy
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
                  {external && !publiclyReadable ? <span>{t("scope.shared")}</span> : null}
                  {publiclyReadable ? <span>{t("scope.public")}</span> : null}
                </AgentCatalogIndexMeta>
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
      <AgentMasterDetailHeader className="models-provider-detail__header flex min-h-20 items-center justify-between gap-4.5 px-5 py-3.5">
        <div className="models-provider-identity flex min-w-0 items-center gap-3.25">
          <span className="models-provider-detail-brand grid size-10.5 shrink-0 grow-0 basis-10.5 place-items-center rounded-9 [--ant-color-text-description:currentColor]">
            <ModelIcon modelId={iconModelId} size={25} />
          </span>
          <div>
            <div className="models-provider-meta flex items-center gap-2">
              <span className="text-9 font-bold uppercase text-blue-600 tracking-4">
                {t(`protocolOptions.${provider.protocol}`)}
              </span>
              {provider.kind === "gateway" && (
                <span className="text-9 font-bold uppercase text-blue-600 tracking-4">{t("gateway.tag")}</span>
              )}
              <code className="text-9 text-slate-400">{provider.id}</code>
            </div>
            <h2 className="mt-0.75 mb-0.5 text-17 leading-[1.2]">{provider.name || provider.id}</h2>
            <div className="models-provider-organization flex items-center gap-1.5">
              <small className="text-9 text-slate-400">
                {external ? t("scope.shared") : t("scope.organization")} ·{" "}
                {t("providerIndex.models", { count: models.length })}
              </small>
              {external && !publiclyReadable ? (
                <span className="models-provider-public-badge inline-block rounded-5 border border-blue-200 px-1.5 py-0.75 bg-blue-50 text-9 text-blue-700 font-semibold whitespace-nowrap">
                  {t("scope.shared")}
                </span>
              ) : null}
              {publiclyReadable ? (
                <span className="models-provider-public-badge inline-block rounded-5 border border-blue-200 px-1.5 py-0.75 bg-blue-50 text-9 text-blue-700 font-semibold whitespace-nowrap">
                  {t("scope.public")}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="models-provider-controls flex gap-0.75">
          {provider.kind === "gateway" && (
            <button
              type="button"
              className={`${ACTION_BTN} min-h-7.5 px-2 ${ACTION_BTN_HOVER}`}
              onClick={() => props.onViewGatewayUsage(provider)}
            >
              {t("gateway.myUsage")}
            </button>
          )}
          {writable ? (
            <>
              <button
                type="button"
                className={`${ACTION_BTN} min-h-7.5 px-2 ${ACTION_BTN_HOVER}`}
                onClick={() => props.onEditProvider(provider)}
              >
                <Pencil className="w-3.25 text-blue-600" /> {t("actions.edit")}
              </button>
              <button
                type="button"
                className={`is-danger ${ACTION_BTN} min-h-7.5 px-2 ${ACTION_BTN_HOVER_DANGER}`}
                onClick={() => props.onDeleteProvider(provider)}
              >
                <Trash2 className="w-3.25 text-blue-600" /> {t("actions.delete")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`${ACTION_BTN} min-h-7.5 px-2 ${ACTION_BTN_HOVER}`}
              onClick={() => props.onViewProvider(provider)}
            >
              <Eye className="w-3.25 text-blue-600" /> {t("actions.view")}
            </button>
          )}
        </div>
      </AgentMasterDetailHeader>
    </div>
  );
  if (props.headerOnly) return header;
  return (
    <article className="models-provider-detail min-w-0 bg-white" style={{ "--provider-color": color } as CSSProperties}>
      <div className="models-provider-connection grid bg-slate-50 px-5">
        <div className="grid min-h-12 min-w-0 items-center gap-1.75 py-0 px-2.5">
          <Server className="w-3.5 text-blue-600" />
          <small className="text-9 text-slate-400">{t("connection.endpoint")}</small>
          <code className="text-3xs truncate text-slate-800" title={provider.baseURL ?? undefined}>
            {provider.baseURL ?? t("connection.defaultEndpoint")}
          </code>
        </div>
        <div className="grid min-h-12 min-w-0 items-center gap-1.75 border-l border-slate-200 py-0 px-2.5">
          <KeyRound className="w-3.5 text-blue-600" />
          <small className="text-9 text-slate-400">{t("connection.credential")}</small>
          <code className="text-3xs truncate text-slate-800">
            {provider.keyHint ?? t("connection.managedCredential")}
          </code>
        </div>
        <label className="models-provider-visibility flex min-w-0 items-center justify-between gap-3 border-l border-slate-200 px-2.5">
          <span className="flex min-w-0 flex-col">
            <strong className="text-3xs">{t("connection.shared")}</strong>
            <small className="text-9 text-slate-400">{t("connection.sharedDescription")}</small>
          </span>
          <Switch
            checked={publiclyReadable}
            // 公开受众变更要求 `update` 动作（`writable` 已包含该判断与 Gateway 只读约束）。
            disabled={!writable || props.toggling}
            onCheckedChange={(value) => props.onTogglePublic(provider, value)}
          />
        </label>
      </div>
      <section className="models-model-catalog px-5 pt-4.5 pb-6">
        <header className="flex items-center justify-between gap-4 mb-3">
          <div className={writable ? "gap-1.25" : "flex gap-1.25"}>
            <h3 className="mb-0.5 text-15">{t("modelsSection.title")}</h3>
            <small className="text-3xs text-slate-400">
              {t("modelsSection.description", { count: models.length })}
            </small>
          </div>
          {writable && (
            <div className="flex gap-1.25">
              <Button
                variant="ghost"
                size="xs"
                disabled={props.discovering}
                onClick={() => props.onDiscoverModels(provider)}
              >
                {props.discovering ? <LoaderCircle className="animate-spin" /> : <Search />}
                {t("form.fetchModels")}
              </Button>
              <Button size="xs" onClick={() => props.onCreateModel(provider)}>
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
    <div className="models-model-row grid min-h-13.5 items-center gap-2.5 hover:bg-slate-50 px-2 py-1.5">
      <div className="models-model-summary flex min-w-0 items-center gap-2.25">
        <span className="models-model-icon grid size-7 shrink-0 grow-0 basis-7 place-items-center rounded-md [--ant-color-text-description:currentColor]">
          <ModelIcon modelId={model.id} size={17} />
        </span>
        <span className="models-model-identity flex min-w-0 flex-col">
          <strong className="text-xs truncate">{model.name || model.id}</strong>
          <code className="mt-0.5 truncate text-9 text-slate-400">{model.id}</code>
          {/* 失败原因在列表里直接可见（单行截断 + 徽标 title 给出全文），不是只藏在 tooltip 里。 */}
          {test?.status === "error" && test.detail && (
            <small className="models-model-test-detail truncate mt-0.5 text-9 text-red-500">{test.detail}</small>
          )}
        </span>
      </div>
      <div className="models-model-actions flex items-center gap-0.25">
        {test && (
          <span
            className={`models-model-test flex items-center gap-1 mr-1 text-9 ${TEST_STATUS_COLOR[test.status]}`}
            title={test.detail}
          >
            {test.status === "running" ? (
              <LoaderCircle className="w-3 animate-spin" />
            ) : test.status === "success" ? (
              <CheckCircle2 className="w-3" />
            ) : (
              <XCircle className="w-3" />
            )}
            {t(`testStatus.${test.status}`)}
          </span>
        )}
        {writable ? (
          <>
            <button
              type="button"
              className={`${ACTION_BTN} min-h-6.75 px-1.5 ${ACTION_BTN_HOVER}`}
              disabled={testing}
              onClick={() => onTest(provider, model)}
            >
              {t("actions.test")}
            </button>
            <button
              type="button"
              className={`${ACTION_BTN} min-h-6.75 px-1.5 ${ACTION_BTN_HOVER}`}
              onClick={() => onEdit(provider, model)}
            >
              {t("actions.edit")}
            </button>
            <button
              type="button"
              className={`is-danger ${ACTION_BTN} min-h-6.75 px-1.5 ${ACTION_BTN_HOVER_DANGER}`}
              onClick={() => onDelete(provider, model)}
            >
              {t("actions.delete")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="min-h-6.75 gap-1.25 rounded-md text-3xs py-0 px-1.5"
            onClick={() => onView(provider, model)}
          >
            {t("actions.view")}
          </button>
        )}
      </div>
    </div>
  );
}
