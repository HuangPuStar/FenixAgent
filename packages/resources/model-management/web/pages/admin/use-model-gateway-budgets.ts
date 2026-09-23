/**
 * 「预算」Tab 的状态与请求：`ModelGatewayBudgetsPanel` 的控制器。
 *
 * §4.7 拆分（2026-09-23）：这一段原先与其余四块的状态挤在 `ModelGatewayDashboard` 的 20 个 `useState` 里，
 * 与它们各自的 JSX 相隔数百行。切分的判据是**状态归属**而不是行数——筛选、分页、勾选、弹窗与三个预算请求
 * 只被预算 Tab 消费，一律随本模块走；用户 / 组织两路下拉由 `useModelGatewayDashboard` 编排（用量 Tab 也读），
 * 因此不在本模块内。
 *
 * 形态是 hook 而不是面板内的 `useState`：本 hook 由 Dashboard 调用，状态因此**仍活过「切走再切回」**
 * （与拆分前一致）——搬进面板会让回来时筛选、页码与已查结果全部重置，那是行为变更而不是结构调整。
 * `active`（当前是否停在本 Tab）用于保留原先重查条件里的 `tab === "budgets"` 一档。
 */
import { ApiError } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { listModelGatewayBudgets, resetModelGatewayBudgets, updateModelGatewayBudgets } from "../../api/model-gateway";
import { MODELS_NS } from "../../i18n/namespace";

export function useModelGatewayBudgets({ active, onAuthFailure }: { active: boolean; onAuthFailure: () => void }) {
  const { t } = useTranslation(MODELS_NS);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [budgetAmount, setBudgetAmount] = useState("");
  const [budgetDuration, setBudgetDuration] = useState("30d");
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
      // 只有系统 API 明确返回未授权时才清理 Master Key；网关或数据库故障不能被误判为鉴权失败。
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
      toast.error(t("modelGateway.budgetsPage.resetError"));
    },
  });

  const visibleBudgetItems = budgetsRequest.data?.items ?? [];
  const budgetTotalPages = Math.max(1, Math.ceil((budgetsRequest.data?.total ?? 0) / budgetPageSize));
  const budgetQueryKey = JSON.stringify({
    filters: appliedBudgetFilters,
    page: budgetPage,
    pageSize: budgetPageSize,
  });

  // 拆走前这条 effect 的判据是 `tab === "budgets" && hasQueriedBudgets && budgetQueryKey`：首屏进来不自动查，
  // 「查询」按钮把 `hasQueriedBudgets` 置真、改分页 / 筛选改查询键，之后才重拉。三者一字不动。
  useEffect(() => {
    if (active && hasQueriedBudgets && budgetQueryKey) void budgetsRequest.run();
  }, [active, budgetQueryKey, budgetsRequest.run, hasQueriedBudgets]);

  return {
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
  };
}

/** 面板的入参形状：状态与请求由 hook 提供，`ModelGatewayBudgetsPanel` 据此只做渲染。 */
export type ModelGatewayBudgetsController = ReturnType<typeof useModelGatewayBudgets>;
