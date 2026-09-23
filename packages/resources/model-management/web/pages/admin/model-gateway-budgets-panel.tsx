/**
 * 模型网关管理页的「预算」Tab：默认预算回显 + 主体筛选 + 勾选与批量动作 + 预算表与分页 + 两个弹窗的挂载点。
 *
 * §4.7 拆分（2026-09-23）：整块从 `AdminModelGatewayPage.tsx` 里移出，只做渲染——筛选、分页、勾选、
 * 弹窗与三个预算请求都由 `useModelGatewayBudgets` 持有（回见该文件对「为什么是 hook 而不是面板内 state」
 * 的说明）。用户 / 组织两路下拉的取数与标签在 `useModelGatewayDashboard` 侧统一拼装，这里只收成品选项。
 */
import { SearchableUsageFilter } from "@fenix/resource-sandbox/web";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@fenix/ui-components/ui/card";
import { Pagination } from "@fenix/ui-components/ui/pagination";
import { Progress } from "@fenix/ui-components/ui/progress";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ModelGatewayConfiguration } from "../../api/model-gateway";
import { MODELS_NS } from "../../i18n/namespace";
import { resolveModelGatewayQueryBranch } from "../../lib/model-gateway-query";
import { ModelGatewayBudgetDialog, ModelGatewayResetBudgetDialog } from "./model-gateway-budget-dialogs";
import {
  FILTER_FIELD_CLASS,
  GATEWAY_LOADING_CLASS,
  GATEWAY_TABLE_SHELL_CLASS,
  ModelGatewayEmptyRow,
  READONLY_FIELD_CLASS,
} from "./model-gateway-shared";
import type { ModelGatewayBudgetsController } from "./use-model-gateway-budgets";
import type { ModelGatewayFilterOption } from "./use-model-gateway-dashboard";

export function ModelGatewayBudgetsPanel({
  budgets,
  config,
  organizationOptions,
  userOptions,
  onUserSearchChange,
}: {
  /** 本 Tab 的状态、请求与派生：由 `useModelGatewayBudgets` 在页面侧调用后整包传入。 */
  budgets: ModelGatewayBudgetsController;
  config: ModelGatewayConfiguration | undefined;
  organizationOptions: ModelGatewayFilterOption[];
  userOptions: ModelGatewayFilterOption[];
  onUserSearchChange: (keyword: string) => void;
}) {
  const { t } = useTranslation(MODELS_NS);
  // 解构一次，下面整段 JSX 与拆分前逐字一致（只把 `configRequest.data` 换成上面传进来的 `config`）。
  const {
    selectedUsers,
    setSelectedUsers,
    budgetAmount,
    setBudgetAmount,
    budgetDuration,
    setBudgetDuration,
    budgetOrganizationId,
    setBudgetOrganizationId,
    budgetUserId,
    setBudgetUserId,
    budgetFilter,
    setBudgetFilter,
    setAppliedBudgetFilters,
    setHasQueriedBudgets,
    budgetPage,
    setBudgetPage,
    budgetPageSize,
    setBudgetPageSize,
    budgetDialog,
    setBudgetDialog,
    resetBudgetDialogOpen,
    setResetBudgetDialogOpen,
    budgetsRequest,
    budgetUpdateRequest,
    budgetResetRequest,
    visibleBudgetItems,
    budgetTotalPages,
  } = budgets;

  // 失败必须落成失败块：`budgetsRequest.data` 在失败时停在 `undefined`，照旧渲染只会得到一张
  // 空表 + 「暂无匹配用户」的行内文案，与「这组筛选确实没有预算」同形（§3.4）。
  const queryBranch = resolveModelGatewayQueryBranch({
    loading: budgetsRequest.loading,
    error: budgetsRequest.error,
    hasData: Boolean(budgetsRequest.data),
  });

  return (
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
              className={READONLY_FIELD_CLASS}
              type="text"
              value={
                config?.defaultBudget.maxBudgetUsd === null
                  ? t("modelGateway.unlimited")
                  : config?.defaultBudget.maxBudgetUsd === undefined
                    ? t("admin.loading")
                    : `$${config.defaultBudget.maxBudgetUsd}`
              }
              readOnly
            />
            <input
              aria-label={t("modelGateway.budgetsPage.defaultDurationLabel")}
              disabled
              className={READONLY_FIELD_CLASS}
              type="text"
              value={
                config?.defaultBudget.duration === "30d"
                  ? t("modelGateway.budgetsPage.duration30d")
                  : (config?.defaultBudget.duration ?? t("modelGateway.once"))
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
            options={organizationOptions}
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
            options={userOptions}
            searchPlaceholder={t("modelGateway.usagePage.searchSubject", {
              subject: t("modelGateway.usagePage.filters.user"),
            })}
            triggerClassName="w-56"
            value={budgetUserId}
            onSearchChange={onUserSearchChange}
            onValueChange={setBudgetUserId}
          />
          <select
            className={FILTER_FIELD_CLASS}
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
        {queryBranch === "loading" ? (
          <Spinner label={t("admin.loading")} className={GATEWAY_LOADING_CLASS} />
        ) : queryBranch === "failure" && budgetsRequest.error ? (
          // 失败块顶掉表格（含上一轮的行），重试即「按当前筛选重查一次」。
          <EmptyState
            icon={<AlertTriangle />}
            title={t("modelGateway.budgetsPage.queryFailed")}
            tone="danger"
            role="alert"
            className="py-12"
            action={{
              label: t("actions.retry"),
              onClick: () => void budgetsRequest.run(),
              icon: <RefreshCw />,
              disabled: budgetsRequest.loading,
            }}
          />
        ) : (
          <>
            {/* 预算表的 `table-fixed` / 带 `font-medium` 的表头与密钥表不同，只共用最外层容器类。 */}
            <div className={GATEWAY_TABLE_SHELL_CLASS}>
              <table className="w-full min-w-225 table-fixed text-sm">
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
                    <th className="w-28 px-3 py-2 font-medium">{t("modelGateway.budgetsPage.columns.progress")}</th>
                    <th className="w-32 px-3 py-2 font-medium">{t("modelGateway.budgetsPage.columns.resetAt")}</th>
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
                                event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
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
                            {budget.maxBudgetUsd === null ? t("modelGateway.unlimited") : `$${budget.maxBudgetUsd}`}/
                            {budget.duration ?? t("modelGateway.once")}
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
                        <td className={exhausted ? "px-3 py-3 align-top text-destructive" : "px-3 py-3 align-top"}>
                          {remaining === null ? "—" : `$${remaining.toFixed(2)}`}
                        </td>
                        <td className="px-3 py-3 align-top">
                          {progress === null ? (
                            <span className="text-text-muted">—</span>
                          ) : (
                            <div className="space-y-1.5">
                              <Progress
                                className={exhausted ? "[&>[data-slot=progress-indicator]]:bg-destructive" : undefined}
                                value={progress}
                              />
                              <span className={exhausted ? "text-xs text-destructive" : "text-xs text-text-muted"}>
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
                    <ModelGatewayEmptyRow colSpan={8} title={t("modelGateway.budgetsPage.noMatches")} />
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
        <ModelGatewayBudgetDialog
          target={budgetDialog}
          amount={budgetAmount}
          duration={budgetDuration}
          selectedCount={selectedUsers.length}
          submitting={budgetUpdateRequest.loading}
          onAmountChange={setBudgetAmount}
          onDurationChange={setBudgetDuration}
          onClose={() => setBudgetDialog(null)}
          onConfirm={() => budgetUpdateRequest.run()}
        />
        <ModelGatewayResetBudgetDialog
          open={resetBudgetDialogOpen}
          count={selectedUsers.length}
          resetting={budgetResetRequest.loading}
          onOpenChange={setResetBudgetDialogOpen}
          onConfirm={() => budgetResetRequest.run()}
        />
      </CardContent>
    </Card>
  );
}
