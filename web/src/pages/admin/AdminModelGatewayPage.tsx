import { useRequest } from "ahooks";
import { ExternalLink, Info, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer } from "@/components/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Pagination } from "@/components/ui/pagination";
import { Progress } from "@/components/ui/progress";
import {
  checkModelGateway,
  getModelGatewayConfiguration,
  listModelGatewayAgents,
  listModelGatewayBudgets,
  listModelGatewayUsers,
  type ModelSyncStatus,
  queryModelGatewayUsage,
  resetModelGatewayBudgets,
  syncModelGateway,
  updateModelGatewayBudgets,
} from "../../api/model-gateway";
import { ApiError } from "../../api/request";
import { fetchSystemPeopleTree } from "../../api/system-people-tree";
import { clearAdminKey, getAdminKey } from "../../lib/admin-key";
import { buildRecentUsageDateRange } from "../../lib/model-gateway-usage";
import { MasterKeyGate } from "./components/MasterKeyGate";
import { SearchableUsageFilter } from "./components/SearchableUsageFilter";
import { getModelGatewayConnectionFeedback } from "./model-gateway-feedback";
import { buildModelGatewayOverviewUsageQuery, buildSevenDayUsageTrend } from "./model-gateway-overview";

/** 系统模型网关管理页一期壳：模型目录仍由 LiteLLM 管理，Fenix 只负责检查和投影同步。 */
export function AdminModelGatewayPage() {
  const { t } = useTranslation("observer");
  const [unlocked, setUnlocked] = useState(() => getAdminKey() !== null);
  const [gateError, setGateError] = useState<string | null>(null);

  if (!unlocked) {
    return (
      <MasterKeyGate
        error={gateError}
        onUnlock={() => {
          setGateError(null);
          setUnlocked(true);
        }}
      />
    );
  }
  return (
    <ModelGatewayDashboard
      onAuthFailure={() => {
        clearAdminKey();
        setGateError(t("login.error"));
        setUnlocked(false);
      }}
    />
  );
}

function ModelGatewayDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { i18n, t } = useTranslation("observer");
  const [status, setStatus] = useState<ModelSyncStatus | null>(null);
  const [tab, setTab] = useState<"overview" | "models" | "budgets" | "usage">("overview");
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [budgetAmount, setBudgetAmount] = useState("");
  const [budgetDuration, setBudgetDuration] = useState("30d");
  const [userSearchKeyword, setUserSearchKeyword] = useState<string | null>(null);
  const [agentSearchKeyword, setAgentSearchKeyword] = useState<string | null>(null);
  const [budgetOrganizationId, setBudgetOrganizationId] = useState("");
  const [budgetUserId, setBudgetUserId] = useState("");
  const [budgetFilter, setBudgetFilter] = useState<"all" | "pending" | "active" | "exhausted">("all");
  const [appliedBudgetFilters, setAppliedBudgetFilters] = useState({
    organizationId: "",
    userId: "",
    budgetStatus: "all" as "all" | "pending" | "active" | "exhausted",
  });
  const [hasQueriedBudgets, setHasQueriedBudgets] = useState(false);
  const [budgetPage, setBudgetPage] = useState(1);
  const [budgetPageSize, setBudgetPageSize] = useState(20);
  const [budgetDialog, setBudgetDialog] = useState<"batch" | string | null>(null);
  const [resetBudgetDialogOpen, setResetBudgetDialogOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [modelFilter, setModelFilter] = useState("all");
  const [usageRange, setUsageRange] = useState("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [usageFilters, setUsageFilters] = useState({
    userId: "",
    organizationId: "",
    agentConfigId: "",
    modelId: "",
  });
  const handleGatewayRequestError = (error: Error) => {
    // 只有系统 API 明确返回未授权时才清理 Master Key；网关或数据库故障不能被误判为鉴权失败。
    if (error instanceof ApiError && error.code === "UNAUTHORIZED") {
      onAuthFailure();
    }
  };
  const checkRequest = useRequest(() => checkModelGateway(), {
    manual: true,
    onSuccess: setStatus,
    onError: handleGatewayRequestError,
  });
  const configRequest = useRequest(() => getModelGatewayConfiguration(), {
    manual: true,
    onError: handleGatewayRequestError,
  });
  const syncRequest = useRequest(() => syncModelGateway(), {
    manual: true,
    onSuccess: () => {
      setStatus((current) => (current ? { ...current, status: "synced", changes: [] } : current));
      void checkRequest.run();
    },
    onError: handleGatewayRequestError,
  });
  const budgetsRequest = useRequest(
    () =>
      listModelGatewayBudgets(budgetPage, budgetPageSize, {
        organizationId: appliedBudgetFilters.organizationId,
        userId: appliedBudgetFilters.userId,
        budgetStatus: appliedBudgetFilters.budgetStatus === "all" ? undefined : appliedBudgetFilters.budgetStatus,
      }),
    {
      manual: true,
    },
  );
  const usersRequest = useRequest((keyword?: string) => listModelGatewayUsers(keyword?.trim() ? { keyword } : {}), {
    manual: true,
  });
  const agentsRequest = useRequest((keyword?: string) => listModelGatewayAgents(keyword?.trim() ? { keyword } : {}), {
    manual: true,
  });
  const organizationsRequest = useRequest(() => fetchSystemPeopleTree(), {
    manual: true,
    onError: handleGatewayRequestError,
  });
  const usageRequest = useRequest(
    () => {
      const range =
        usageRange === "custom"
          ? { startAt: customStart, endAt: customEnd }
          : buildRecentUsageDateRange(Number(usageRange.replace("d", "")));
      return queryModelGatewayUsage({
        ...range,
        includeBreakdowns: true,
        ...Object.fromEntries(Object.entries(usageFilters).filter(([, value]) => value.trim())),
      });
    },
    { manual: true },
  );
  const overviewUsageRequest = useRequest(() => queryModelGatewayUsage(buildModelGatewayOverviewUsageQuery()), {
    manual: true,
    onError: handleGatewayRequestError,
  });
  const budgetUpdateRequest = useRequest(
    () =>
      updateModelGatewayBudgets(
        selectedUsers,
        budgetAmount === "" ? null : Number(budgetAmount),
        budgetDuration === "once" ? null : budgetDuration,
      ),
    {
      manual: true,
      onSuccess: () => {
        setSelectedUsers([]);
        setBudgetDialog(null);
        void budgetsRequest.run();
      },
    },
  );
  const budgetResetRequest = useRequest(() => resetModelGatewayBudgets(selectedUsers), {
    manual: true,
    onSuccess: () => {
      setSelectedUsers([]);
      setResetBudgetDialogOpen(false);
      toast.success(t("modelGateway.budgetsPage.resetSuccess"));
      void budgetsRequest.run();
    },
    onError: (error) => {
      handleGatewayRequestError(error);
      toast.error(t("modelGateway.budgetsPage.resetError"));
    },
  });
  const checking = checkRequest.loading;
  const syncing = syncRequest.loading;
  const busy = checking || syncing;
  const displayedModels = useMemo(() => {
    const models = status?.models ?? [];
    return models.filter((model) => {
      const matchesSearch = !modelSearch.trim() || model.id.toLowerCase().includes(modelSearch.trim().toLowerCase());
      const change = status?.changes.find((item) => item.modelId === model.id);
      const matchesFilter = modelFilter === "all" || (modelFilter === "pending" ? Boolean(change) : !change);
      return matchesSearch && matchesFilter;
    });
  }, [modelFilter, modelSearch, status]);
  const visibleBudgetItems = budgetsRequest.data?.items ?? [];
  const budgetTotalPages = Math.max(1, Math.ceil((budgetsRequest.data?.total ?? 0) / budgetPageSize));
  const budgetQueryKey = JSON.stringify({
    filters: appliedBudgetFilters,
    page: budgetPage,
    pageSize: budgetPageSize,
  });

  async function runConnectionCheck(): Promise<void> {
    try {
      const result = await checkRequest.runAsync();
      const feedback = getModelGatewayConnectionFeedback(result);
      if (feedback.level === "success") toast.success(t(feedback.translationKey, feedback.values));
      else toast.error(t(feedback.translationKey, feedback.values));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : t("modelGateway.connectionCheck.requestFailed"));
    }
  }

  useEffect(() => {
    void checkRequest.run();
    void configRequest.run();
    void overviewUsageRequest.run();
  }, [checkRequest.run, configRequest.run, overviewUsageRequest.run]);

  useEffect(() => {
    if (tab === "budgets" && hasQueriedBudgets && budgetQueryKey) void budgetsRequest.run();
  }, [budgetQueryKey, budgetsRequest.run, hasQueriedBudgets, tab]);

  useEffect(() => {
    if (userSearchKeyword === null) return;
    // 主体搜索走后端关键词查询；3 秒静默后才发起请求，避免输入时持续压测系统 API。
    const timer = window.setTimeout(() => void usersRequest.run(userSearchKeyword.trim()), 3000);
    return () => window.clearTimeout(timer);
  }, [userSearchKeyword, usersRequest.run]);

  useEffect(() => {
    if (agentSearchKeyword === null) return;
    // Agent 与用户共用同一防抖策略，旧请求先取消，避免慢响应覆盖最新关键词结果。
    const timer = window.setTimeout(() => void agentsRequest.run(agentSearchKeyword.trim()), 3000);
    return () => window.clearTimeout(timer);
  }, [agentSearchKeyword, agentsRequest.run]);

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t("modelGateway.title")}</h1>
            <p className="mt-1 text-sm text-text-muted">{t("modelGateway.subtitle")}</p>
          </div>
        </header>

        <div className="flex gap-1 border-b border-border">
          {(["overview", "models", "budgets", "usage"] as const).map((item) => (
            <Button
              key={item}
              variant={tab === item ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                setTab(item);
                if (item === "budgets") {
                  if (!usersRequest.data) void usersRequest.run();
                  if (!organizationsRequest.data) void organizationsRequest.run();
                }
                if (item === "usage") {
                  if (!agentsRequest.data) void agentsRequest.run();
                  if (!usersRequest.data) void usersRequest.run();
                  if (!organizationsRequest.data) void organizationsRequest.run();
                }
              }}
            >
              {t(`modelGateway.tabs.${item}`)}
            </Button>
          ))}
        </div>

        {tab === "overview" ? (
          <OverviewPanel
            status={status}
            config={configRequest.data}
            usage={overviewUsageRequest.data}
            loading={checkRequest.loading || overviewUsageRequest.loading}
            error={checkRequest.error ?? overviewUsageRequest.error}
            onRefresh={() => {
              void runConnectionCheck();
              void overviewUsageRequest.run();
            }}
            onModels={() => setTab("models")}
          />
        ) : tab === "models" ? (
          <div className="space-y-4">
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="flex flex-wrap items-center gap-4 py-4">
                <Info className="size-5 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text-primary">
                    {t("modelGateway.modelsPage.litellmConfig.title")}
                  </p>
                  <p className="mt-1 text-sm text-text-muted">
                    {t("modelGateway.modelsPage.litellmConfig.description")}
                  </p>
                </div>
                {configRequest.data?.adminUiUrl ? (
                  <Button asChild size="sm">
                    <a href={configRequest.data.adminUiUrl} target="_blank" rel="noreferrer">
                      {t("modelGateway.modelsPage.litellmConfig.action")}
                      <ExternalLink className="size-3.5" />
                    </a>
                  </Button>
                ) : (
                  <Button size="sm" disabled>
                    {t("modelGateway.modelsPage.litellmConfig.action")}
                    <ExternalLink className="size-3.5" />
                  </Button>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-sm">{t("modelGateway.modelsPage.title")}</CardTitle>
                  <p className="mt-1 text-xs text-text-muted">{t("modelGateway.modelsPage.description")}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => void runConnectionCheck()} disabled={busy}>
                    <RefreshCw className={checking ? "size-3.5 animate-spin" : "size-3.5"} />
                    {t("modelGateway.check")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => syncRequest.run()}
                    disabled={busy || (status?.status !== "pending" && !status?.providerBaseUrlChanged)}
                  >
                    <RefreshCw className={syncing ? "size-3.5 animate-spin" : "size-3.5"} />
                    {t("modelGateway.sync")}
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-4 flex flex-wrap gap-2">
                  <input
                    className="h-8 min-w-56 rounded-md border bg-background px-2 text-sm"
                    placeholder={t("modelGateway.modelsPage.searchPlaceholder")}
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                  />
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-sm"
                    value={modelFilter}
                    onChange={(event) => setModelFilter(event.target.value)}
                  >
                    <option value="all">{t("modelGateway.modelsPage.filters.all")}</option>
                    <option value="pending">{t("modelGateway.modelsPage.filters.pending")}</option>
                    <option value="synced">{t("modelGateway.modelsPage.filters.synced")}</option>
                  </select>
                </div>
                {!status ? (
                  <p className="py-8 text-center text-sm text-text-muted">{t("modelGateway.checkHint")}</p>
                ) : status.status === "unknown" ? (
                  <ErrorMessage message={status.error ?? t("modelGateway.unknown")} />
                ) : (
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="px-3 py-2">{t("modelGateway.modelsPage.columns.model")}</th>
                          <th className="px-3 py-2">{t("modelGateway.modelsPage.columns.source")}</th>
                          <th className="px-3 py-2">{t("modelGateway.modelsPage.columns.syncStatus")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {displayedModels.map((model) => {
                          const change = status.changes.find((item) => item.modelId === model.id);
                          return (
                            <tr key={model.id}>
                              <td className="px-3 py-2 font-medium">{model.displayName ?? model.id}</td>
                              <td className="px-3 py-2 text-text-muted">LiteLLM</td>
                              <td className="px-3 py-2">
                                {change ? (
                                  <Badge variant="outline">{t(`modelGateway.change.${change.kind}`)}</Badge>
                                ) : (
                                  <span className="text-green-700">{t("modelGateway.synced")}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {displayedModels.length === 0 && (
                          <tr>
                            <td colSpan={3} className="px-3 py-8 text-center text-text-muted">
                              {t("modelGateway.modelsPage.noMatches")}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
                {status && (status.changes.length > 0 || status.providerBaseUrlChanged) && (
                  <p className="mt-3 text-sm text-amber-700">
                    {status.providerBaseUrlChanged
                      ? t("modelGateway.modelsPage.providerBaseUrlChanged")
                      : t("modelGateway.modelsPage.catalogChanges", {
                          count: status.changes.length,
                        })}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        ) : tab === "budgets" ? (
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="text-sm">{t("modelGateway.budgets")}</CardTitle>
                <p className="mt-1 text-xs text-text-muted">{t("modelGateway.budgetsPage.budgetScope")}</p>
              </div>
            </CardHeader>
            <CardContent>
              <div className="mb-4 rounded-md border bg-muted/20 p-3">
                <p className="mb-2 text-sm font-medium">{t("modelGateway.budgetsPage.defaultTitle")}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    aria-label={t("modelGateway.budgetsPage.defaultAmountLabel")}
                    disabled
                    className="h-8 w-28 rounded-md border bg-muted px-2 text-sm"
                    type="text"
                    value={
                      configRequest.data?.defaultBudget.maxBudgetUsd === null
                        ? t("modelGateway.unlimited")
                        : configRequest.data?.defaultBudget.maxBudgetUsd === undefined
                          ? t("states.loading")
                          : `$${configRequest.data.defaultBudget.maxBudgetUsd}`
                    }
                    readOnly
                  />
                  <input
                    aria-label={t("modelGateway.budgetsPage.defaultDurationLabel")}
                    disabled
                    className="h-8 w-28 rounded-md border bg-muted px-2 text-sm"
                    type="text"
                    value={
                      configRequest.data?.defaultBudget.duration === "30d"
                        ? t("modelGateway.budgetsPage.duration30d")
                        : (configRequest.data?.defaultBudget.duration ?? t("modelGateway.once"))
                    }
                    readOnly
                  />
                  <span className="text-xs text-text-muted">{t("modelGateway.budgetsPage.defaultHint")}</span>
                </div>
              </div>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <SearchableUsageFilter
                  allLabel={t("modelGateway.budgetsPage.allOrganizations")}
                  emptyLabel={t("modelGateway.usagePage.noMatches")}
                  options={(organizationsRequest.data?.organizations ?? []).map((organization) => ({
                    value: organization.id,
                    label: `${organization.name}（${organization.id}）`,
                  }))}
                  searchPlaceholder={t("modelGateway.usagePage.searchSubject", {
                    subject: t("modelGateway.usagePage.filters.organization"),
                  })}
                  triggerClassName="w-56"
                  value={budgetOrganizationId}
                  onValueChange={setBudgetOrganizationId}
                />
                <SearchableUsageFilter
                  allLabel={t("modelGateway.budgetsPage.allUsers")}
                  emptyLabel={t("modelGateway.usagePage.noMatches")}
                  options={(usersRequest.data?.items ?? []).map((user) => ({
                    value: user.id,
                    label: t("modelGateway.usagePage.userOption", {
                      name: user.name,
                      email: user.email,
                    }),
                  }))}
                  searchPlaceholder={t("modelGateway.usagePage.searchSubject", {
                    subject: t("modelGateway.usagePage.filters.user"),
                  })}
                  triggerClassName="w-56"
                  value={budgetUserId}
                  onSearchChange={(keyword) => {
                    usersRequest.cancel();
                    setUserSearchKeyword(keyword);
                  }}
                  onValueChange={setBudgetUserId}
                />
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                  value={budgetFilter}
                  onChange={(event) => setBudgetFilter(event.target.value as typeof budgetFilter)}
                >
                  <option value="all">{t("modelGateway.budgetsPage.filters.all")}</option>
                  <option value="pending">{t("modelGateway.budgetsPage.filters.pending")}</option>
                  <option value="active">{t("modelGateway.budgetsPage.filters.active")}</option>
                  <option value="exhausted">{t("modelGateway.budgetsPage.filters.exhausted")}</option>
                </select>
                <Button
                  size="sm"
                  onClick={() => {
                    setAppliedBudgetFilters({
                      organizationId: budgetOrganizationId,
                      userId: budgetUserId,
                      budgetStatus: budgetFilter,
                    });
                    setSelectedUsers([]);
                    setBudgetPage(1);
                    setHasQueriedBudgets(true);
                  }}
                >
                  {t("modelGateway.query")}
                </Button>
              </div>
              <div className="mb-2 flex items-center justify-end gap-2">
                {selectedUsers.length > 0 && (
                  <Badge variant="secondary">
                    {t("modelGateway.budgetsPage.selectedCount", {
                      count: selectedUsers.length,
                    })}
                  </Badge>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={selectedUsers.length === 0}
                  onClick={() => setResetBudgetDialogOpen(true)}
                >
                  {t("modelGateway.budgetsPage.resetBudget")}
                </Button>
                <Button
                  size="sm"
                  disabled={selectedUsers.length === 0}
                  onClick={() => {
                    setBudgetAmount("");
                    setBudgetDuration("30d");
                    setBudgetDialog("batch");
                  }}
                >
                  {t("modelGateway.applySelected")}
                </Button>
              </div>
              {budgetsRequest.loading ? (
                <p className="py-8 text-center text-sm text-text-muted">{t("states.loading")}</p>
              ) : (
                <>
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full min-w-[900px] table-fixed text-sm">
                      <thead className="border-b bg-muted/30 text-left text-text-muted">
                        <tr>
                          <th className="w-10 px-3 py-2">
                            <input
                              aria-label={t("modelGateway.selectAll")}
                              type="checkbox"
                              checked={
                                visibleBudgetItems.length > 0 &&
                                visibleBudgetItems.every((item) => selectedUsers.includes(item.id))
                              }
                              onChange={(event) =>
                                setSelectedUsers(event.target.checked ? visibleBudgetItems.map((item) => item.id) : [])
                              }
                            />
                          </th>
                          <th className="w-44 px-3 py-2 font-medium">{t("modelGateway.budgetsPage.columns.user")}</th>
                          <th className="px-3 py-2 font-medium">{t("modelGateway.budgetsPage.columns.policy")}</th>
                          <th className="px-3 py-2 font-medium">{t("modelGateway.budgetsPage.columns.spent")}</th>
                          <th className="px-3 py-2 font-medium">{t("modelGateway.budgetsPage.columns.remaining")}</th>
                          <th className="w-28 px-3 py-2 font-medium">
                            {t("modelGateway.budgetsPage.columns.progress")}
                          </th>
                          <th className="w-32 px-3 py-2 font-medium">
                            {t("modelGateway.budgetsPage.columns.resetAt")}
                          </th>
                          <th className="sticky right-0 z-10 w-40 bg-muted/30 px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {visibleBudgetItems.map((item) => {
                          const budget = item.budget;
                          const limit = item.isActivated ? budget.maxBudgetUsd : null;
                          const remaining = limit === null ? null : Math.max(0, limit - budget.spendUsd);
                          const progress =
                            limit === null
                              ? null
                              : limit === 0
                                ? budget.spendUsd > 0
                                  ? 100
                                  : 0
                                : Math.min(100, (budget.spendUsd / limit) * 100);
                          const exhausted = progress === 100;
                          return (
                            <tr className="border-b last:border-0" key={item.id}>
                              <td className="px-3 py-3 align-top">
                                <input
                                  aria-label={t("modelGateway.budgetsPage.selectUser", { name: item.name })}
                                  type="checkbox"
                                  checked={selectedUsers.includes(item.id)}
                                  onChange={(event) =>
                                    setSelectedUsers((current) =>
                                      event.target.checked
                                        ? [...current, item.id]
                                        : current.filter((id) => id !== item.id),
                                    )
                                  }
                                />
                              </td>
                              <td className="w-44 px-3 py-3 align-top">
                                <p className="truncate font-medium text-text-primary">{item.name}</p>
                                <p className="mt-0.5 truncate text-xs text-text-muted">{item.email}</p>
                              </td>
                              <td className="w-28 px-3 py-3 align-top">
                                <p className="font-medium">
                                  {budget.maxBudgetUsd === null
                                    ? t("modelGateway.unlimited")
                                    : `$${budget.maxBudgetUsd}`}
                                  /{budget.duration ?? t("modelGateway.once")}
                                </p>
                                <Badge className="mt-1" variant={item.isActivated ? "secondary" : "outline"}>
                                  {item.isActivated
                                    ? t("modelGateway.budgetsPage.activeBudget")
                                    : t("modelGateway.budgetsPage.defaultPreview")}
                                </Badge>
                              </td>
                              <td className="px-3 py-3 align-top">
                                {item.isActivated ? `$${budget.spendUsd.toFixed(2)}` : "—"}
                              </td>
                              <td
                                className={exhausted ? "px-3 py-3 align-top text-destructive" : "px-3 py-3 align-top"}
                              >
                                {remaining === null ? "—" : `$${remaining.toFixed(2)}`}
                              </td>
                              <td className="px-3 py-3 align-top">
                                {progress === null ? (
                                  <span className="text-text-muted">—</span>
                                ) : (
                                  <div className="space-y-1.5">
                                    <Progress
                                      className={
                                        exhausted ? "[&>[data-slot=progress-indicator]]:bg-destructive" : undefined
                                      }
                                      value={progress}
                                    />
                                    <span
                                      className={exhausted ? "text-xs text-destructive" : "text-xs text-text-muted"}
                                    >
                                      {exhausted ? t("modelGateway.budgetsPage.exhausted") : `${Math.round(progress)}%`}
                                    </span>
                                  </div>
                                )}
                              </td>
                              <td className="w-32 px-3 py-3 align-top text-text-muted">
                                {!item.isActivated
                                  ? t("modelGateway.budgetsPage.startsOnFirstUse")
                                  : budget.resetAt
                                    ? new Intl.DateTimeFormat(undefined, {
                                        dateStyle: "short",
                                        timeStyle: "short",
                                      }).format(new Date(budget.resetAt))
                                    : budget.duration === null
                                      ? t("modelGateway.budgetsPage.neverResets")
                                      : t("modelGateway.budgetsPage.resetNotScheduled")}
                              </td>
                              <td className="sticky right-0 z-10 w-40 bg-background px-3 py-3 align-top">
                                <div className="flex gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                      setSelectedUsers([item.id]);
                                      setResetBudgetDialogOpen(true);
                                    }}
                                  >
                                    {t("modelGateway.budgetsPage.resetBudget")}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                      setBudgetDialog(item.id);
                                      setSelectedUsers([item.id]);
                                      setBudgetAmount(item.budget.maxBudgetUsd?.toString() ?? "");
                                      setBudgetDuration(item.budget.duration ?? "once");
                                    }}
                                  >
                                    {t("modelGateway.budgetsPage.edit")}
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {visibleBudgetItems.length === 0 && (
                          <tr>
                            <td className="px-3 py-8 text-center text-text-muted" colSpan={8}>
                              {t("modelGateway.budgetsPage.noMatches")}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={budgetPage}
                    totalPages={budgetTotalPages}
                    total={budgetsRequest.data?.total ?? 0}
                    pageSize={budgetPageSize}
                    onPageChange={setBudgetPage}
                    onPageSizeChange={setBudgetPageSize}
                    translationPrefix="modelGateway.budgetsPage"
                    t={t}
                  />
                </>
              )}
              <Dialog open={budgetDialog !== null} onOpenChange={(open) => !open && setBudgetDialog(null)}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>
                      {t(
                        budgetDialog === "batch"
                          ? "modelGateway.budgetsPage.batchTitle"
                          : "modelGateway.budgetsPage.editTitle",
                      )}
                    </DialogTitle>
                    <DialogDescription>
                      {t("modelGateway.budgetsPage.dialogHint", {
                        count: selectedUsers.length,
                      })}
                    </DialogDescription>
                  </DialogHeader>
                  <div className="grid gap-3">
                    <input
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      placeholder={t("modelGateway.amount")}
                      value={budgetAmount}
                      onChange={(event) => setBudgetAmount(event.target.value)}
                    />
                    <select
                      className="h-9 rounded-md border bg-background px-3 text-sm"
                      value={budgetDuration}
                      onChange={(event) => setBudgetDuration(event.target.value)}
                    >
                      <option value="once">{t("modelGateway.once")}</option>
                      <option value="1d">1d</option>
                      <option value="7d">7d</option>
                      <option value="30d">30d</option>
                    </select>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setBudgetDialog(null)}>
                      {t("modelGateway.budgetsPage.cancel")}
                    </Button>
                    <Button
                      disabled={budgetAmount === "" || budgetUpdateRequest.loading}
                      onClick={() => budgetUpdateRequest.run()}
                    >
                      {t("modelGateway.budgetsPage.confirmSet")}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <Dialog open={resetBudgetDialogOpen} onOpenChange={setResetBudgetDialogOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>{t("modelGateway.budgetsPage.resetTitle")}</DialogTitle>
                    <DialogDescription>
                      {t("modelGateway.budgetsPage.resetDescription", {
                        count: selectedUsers.length,
                      })}
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setResetBudgetDialogOpen(false)}>
                      {t("modelGateway.budgetsPage.cancel")}
                    </Button>
                    <Button disabled={budgetResetRequest.loading} onClick={() => budgetResetRequest.run()}>
                      {t("modelGateway.budgetsPage.resetBudget")}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="pt-6">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="grid flex-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-sm"
                    value={usageRange}
                    onChange={(event) => setUsageRange(event.target.value)}
                  >
                    <option value="30d">{t("modelGateway.usagePage.ranges.last30d")}</option>
                    <option value="7d">{t("modelGateway.usagePage.ranges.last7d")}</option>
                    <option value="custom">{t("modelGateway.usagePage.ranges.custom")}</option>
                  </select>
                  {usageRange === "custom" && (
                    <>
                      <input
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                        type="date"
                        value={customStart}
                        onChange={(event) => setCustomStart(event.target.value)}
                      />
                      <input
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                        type="date"
                        value={customEnd}
                        onChange={(event) => setCustomEnd(event.target.value)}
                      />
                    </>
                  )}
                  {(
                    [
                      ["organizationId", "organization"],
                      ["userId", "user"],
                      ["agentConfigId", "agent"],
                      ["modelId", "model"],
                    ] as const
                  ).map(([key, subject]) => {
                    const allLabel = t("modelGateway.usagePage.allSubjects", {
                      subject: t(`modelGateway.usagePage.filters.${subject}`),
                    });
                    if (key !== "modelId") {
                      const options =
                        key === "organizationId"
                          ? (organizationsRequest.data?.organizations ?? []).map((item) => ({
                              value: item.id,
                              label: `${item.name}（${item.id}）`,
                            }))
                          : key === "userId"
                            ? (usersRequest.data?.items ?? []).map((item) => ({
                                value: item.id,
                                label: t("modelGateway.usagePage.userOption", {
                                  name: item.name,
                                  email: item.email,
                                }),
                              }))
                            : (agentsRequest.data ?? []).map((item) => ({
                                value: item.id,
                                label: `${
                                  organizationsRequest.data?.organizations.find(
                                    (organization) => organization.id === item.organizationId,
                                  )?.name ?? item.organizationId
                                } / ${item.name}`,
                              }));
                      return (
                        <SearchableUsageFilter
                          key={key}
                          allLabel={allLabel}
                          emptyLabel={t("modelGateway.usagePage.noMatches")}
                          options={options}
                          searchPlaceholder={t("modelGateway.usagePage.searchSubject", {
                            subject: t(`modelGateway.usagePage.filters.${subject}`),
                          })}
                          value={usageFilters[key]}
                          onSearchChange={
                            key === "userId"
                              ? (keyword) => {
                                  usersRequest.cancel();
                                  setUserSearchKeyword(keyword);
                                }
                              : key === "agentConfigId"
                                ? (keyword) => {
                                    agentsRequest.cancel();
                                    setAgentSearchKeyword(keyword);
                                  }
                                : undefined
                          }
                          onValueChange={(value) => setUsageFilters((current) => ({ ...current, [key]: value }))}
                        />
                      );
                    }
                    return (
                      <select
                        key={key}
                        className="h-8 rounded-md border bg-background px-2 text-sm"
                        value={usageFilters[key]}
                        onChange={(event) => setUsageFilters((current) => ({ ...current, [key]: event.target.value }))}
                      >
                        <option value="">{allLabel}</option>
                        {(status?.models ?? []).map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.displayName ?? item.id}
                          </option>
                        ))}
                      </select>
                    );
                  })}
                </div>
                <Button
                  size="sm"
                  onClick={() => usageRequest.run()}
                  disabled={usageRequest.loading || (usageRange === "custom" && (!customStart || !customEnd))}
                >
                  <Search className={usageRequest.loading ? "size-3.5 animate-spin" : "size-3.5"} />
                  {usageRequest.loading ? t("modelGateway.usagePage.querying") : t("modelGateway.query")}
                </Button>
              </div>
              <p className="mb-4 rounded-md border bg-muted/20 px-3 py-2 text-sm text-text-muted">
                {t("modelGateway.usagePage.rangeHint")}
              </p>
              {!usageRequest.data && <p className="text-sm text-text-muted">{t("modelGateway.queryHint")}</p>}
              {usageRequest.data && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Metric
                      label={t("modelGateway.usagePage.metrics.spend")}
                      value={formatUsd(usageRequest.data.totalSpendUsd, i18n.language)}
                      foot={t("modelGateway.usagePage.metrics.gatewayOnly")}
                    />
                    <Metric
                      label={t("modelGateway.usagePage.metrics.tokens")}
                      value={formatCompactNumber(
                        usageRequest.data.records.reduce(
                          (total, record) => total + record.promptTokens + record.completionTokens,
                          0,
                        ),
                        i18n.language,
                      )}
                      foot={t("modelGateway.usagePage.metrics.tokenDetail", {
                        prompt: formatCompactNumber(
                          usageRequest.data.records.reduce((total, record) => total + record.promptTokens, 0),
                          i18n.language,
                        ),
                        completion: formatCompactNumber(
                          usageRequest.data.records.reduce((total, record) => total + record.completionTokens, 0),
                          i18n.language,
                        ),
                      })}
                    />
                    <Metric
                      label={t("modelGateway.usagePage.metrics.requests")}
                      value={new Intl.NumberFormat(i18n.language).format(
                        usageRequest.data.records.reduce((total, record) => total + record.requests, 0),
                      )}
                    />
                    <Metric
                      label={t("modelGateway.usagePage.metrics.activeAgents")}
                      value={(usageRequest.data.byAgent ?? []).length}
                      foot={t("modelGateway.usagePage.metrics.coveredUsers", {
                        count: usageRequest.data.activeUserCount,
                      })}
                    />
                  </div>
                  <div className="mt-4 space-y-4 text-sm">
                    <UsageBreakdown
                      title={t("modelGateway.usagePage.breakdowns.organization")}
                      items={(usageRequest.data.byOrganization ?? []).map((item) => [
                        item.organizationName
                          ? `${item.organizationName}（${item.organizationId}）`
                          : item.organizationId,
                        item.spendUsd,
                      ])}
                    />
                    <UsageBreakdown
                      title={t("modelGateway.usagePage.breakdowns.model")}
                      items={(usageRequest.data.byModel ?? []).map((item) => [item.modelId, item.spendUsd])}
                    />
                    <UsageBreakdown
                      title={t("modelGateway.usagePage.breakdowns.user")}
                      items={(usageRequest.data.byUser ?? []).map((item) => [
                        item.userName && item.userEmail
                          ? t("modelGateway.usagePage.userOption", {
                              name: item.userName,
                              email: item.userEmail,
                            })
                          : (item.userName ?? item.userEmail ?? item.userId),
                        item.spendUsd,
                      ])}
                    />
                    <UsageBreakdown
                      title={t("modelGateway.usagePage.breakdowns.agent")}
                      items={(usageRequest.data.byAgent ?? []).map((item) => [
                        item.organizationName && item.agentName
                          ? `${item.organizationName} / ${item.agentName}`
                          : (item.agentName ?? item.agentConfigId),
                        item.spendUsd,
                      ])}
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function UsageBreakdown({ title, items }: { title: string; items: Array<[string, number]> }) {
  const { t } = useTranslation("observer");
  const maxSpend = Math.max(...items.map(([, spend]) => spend), 0);
  return (
    <div className="rounded-md border p-3">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="font-medium">{title}</p>
        <span className="text-xs text-text-muted">USD</span>
      </div>
      {items.length === 0 ? (
        <p className="text-text-muted">{t("modelGateway.usagePage.noData")}</p>
      ) : (
        <div className="space-y-4">
          {items.map(([name, spend]) => (
            <div className="grid grid-cols-[24rem_minmax(8rem,1fr)_auto] items-center gap-4" key={name}>
              <span className="truncate font-medium" title={name}>
                {name}
              </span>
              <Progress
                className="h-2 bg-muted [&>[data-slot=progress-indicator]]:bg-gradient-to-r [&>[data-slot=progress-indicator]]:from-[#4b7df3] [&>[data-slot=progress-indicator]]:to-[#7565e8]"
                value={maxSpend > 0 ? (spend / maxSpend) * 100 : 0}
              />
              <span className="min-w-20 text-right tabular-nums text-text-muted">${spend.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type OverviewUsage = {
  totalSpendUsd: number;
  records: Array<{
    date: string;
    spendUsd: number;
    requests: number;
    promptTokens: number;
    completionTokens: number;
  }>;
  activeUserCount: number;
};

function OverviewPanel({
  status,
  config,
  usage,
  loading,
  error,
  onRefresh,
  onModels,
}: {
  status: ModelSyncStatus | null;
  config: import("../../api/model-gateway").ModelGatewayConfiguration | undefined;
  usage: OverviewUsage | undefined;
  loading: boolean;
  error: Error | undefined;
  onRefresh: () => void;
  onModels: () => void;
}) {
  const { i18n, t } = useTranslation("observer");
  const trend = useMemo(() => buildSevenDayUsageTrend(usage?.records ?? []), [usage?.records]);
  const trendData = useMemo(() => trend.map(([date, value]) => ({ date, spend: value.spend })), [trend]);
  const provider = config?.provider;
  const statusLabel =
    status?.status === "synced"
      ? t("modelGateway.overview.connected")
      : status?.status === "pending"
        ? t("modelGateway.pending")
        : t("modelGateway.overview.notChecked");
  const totalPromptTokens = (usage?.records ?? []).reduce((total, record) => total + record.promptTokens, 0);
  const totalCompletionTokens = (usage?.records ?? []).reduce((total, record) => total + record.completionTokens, 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label={t("modelGateway.overview.recent7dSpend")}
          value={usage ? formatUsd(usage.totalSpendUsd, i18n.language) : loading ? t("states.loading") : "—"}
          foot={
            usage
              ? t("modelGateway.overview.tokenSummary", {
                  prompt: formatCompactNumber(totalPromptTokens, i18n.language),
                  completion: formatCompactNumber(totalCompletionTokens, i18n.language),
                })
              : t("modelGateway.overview.onlyGateway")
          }
        />
        <Metric
          label={t("modelGateway.overview.activeUsers")}
          value={usage ? usage.activeUserCount : loading ? t("states.loading") : "—"}
          foot={t("modelGateway.overview.activeUsersFoot7d")}
        />
        <Metric
          label={t("modelGateway.overview.configuredModels")}
          value={provider ? provider.modelCount : loading ? t("states.loading") : "—"}
          foot={
            status?.status === "synced"
              ? t("modelGateway.overview.modelsSynced")
              : t("modelGateway.overview.modelsPending")
          }
        />
      </div>

      {error && (
        <ErrorMessage message={error instanceof ApiError ? error.message : t("modelGateway.overview.loadFailed")} />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="text-sm">{t("modelGateway.overview.usageTrend")}</CardTitle>
              <p className="mt-1 text-xs text-text-muted">{t("modelGateway.overview.recent7dGateway")}</p>
            </div>
            <div className="text-xs text-text-muted">{t("modelGateway.overview.amountUsd")}</div>
          </CardHeader>
          <CardContent>
            {!usage ? (
              <p className="py-12 text-center text-sm text-text-muted">
                {loading ? t("states.loading") : t("modelGateway.overview.noUsage")}
              </p>
            ) : (
              <div className="h-52">
                <ChartContainer>
                  <BarChart data={trendData} margin={{ top: 8, right: 8, left: 0 }}>
                    <CartesianGrid stroke="var(--color-border)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(date: string) => date.slice(5)}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: "var(--color-text-muted)", fontSize: 10 }}
                    />
                    <YAxis
                      width={56}
                      tickFormatter={(value: number) => String(value)}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: "var(--color-text-muted)", fontSize: 10 }}
                    />
                    <Tooltip
                      formatter={(value) => formatUsd(Number(value), i18n.language)}
                      labelFormatter={(date) => String(date)}
                    />
                    <Bar
                      dataKey="spend"
                      fill="var(--color-brand)"
                      name={t("modelGateway.overview.amountUsd")}
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ChartContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="text-sm">{t("modelGateway.overview.gatewayProvider")}</CardTitle>
            </div>
            <Badge variant={status?.status === "synced" ? "default" : "secondary"}>
              <span className="mr-1">●</span>
              {statusLabel}
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-md bg-brand text-lg font-semibold text-white">
                G
              </div>
              <div>
                <p className="font-medium">{provider?.displayName ?? t("modelGateway.overview.defaultProviderName")}</p>
                <p className="text-xs text-text-muted">{provider?.name ?? "—"}</p>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-text-muted">{t("modelGateway.overview.owner")}</dt>
              <dd>{provider ? `${provider.owner.email} / ${provider.owner.organizationSlug}` : "—"}</dd>
              <dt className="text-text-muted">{t("modelGateway.overview.gatewayType")}</dt>
              <dd>
                {provider?.gatewayType === "litellm"
                  ? t("modelGateway.overview.gatewayTypes.litellm")
                  : (provider?.gatewayType ?? "—")}
              </dd>
              <dt className="text-text-muted">{t("modelGateway.overview.connectionAddress")}</dt>
              <dd className="truncate" title={provider?.baseUrl ?? undefined}>
                {provider?.baseUrl ?? "—"}
              </dd>
            </dl>
            <div className="mt-4 flex gap-2">
              <Button variant="outline" size="sm" onClick={onModels}>
                {t("modelGateway.overview.manageModels")}
              </Button>
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
                <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />
                {t("modelGateway.overview.refreshStatus")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function formatCompactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function Metric({ label, value, foot }: { label: string; value: string | number; foot?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {foot && <p className="mt-1 text-xs text-text-muted">{foot}</p>}
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <TriangleAlert className="size-4" />
      {message}
    </div>
  );
}
