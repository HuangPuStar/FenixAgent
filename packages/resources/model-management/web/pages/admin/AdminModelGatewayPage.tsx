// pages/admin/AdminModelGatewayPage.tsx
// 系统模型网关管理页（`/admin/model-gateway`）：Master Key 门 → 概览 / 模型 / 预算 / 用量 / 密钥五个 Tab。
//
// §4.7 拆分（2026-09-23）：本文件原为 1251 行，「页面 + 数据编排 + 传输适配」全挤在一起。拆完只留
// **壳与分派**：门与标题、Tab 条、按 `tab` 把四个面板挂上；数据编排落在同目录的
// `use-model-gateway-dashboard.ts`（跨 Tab 的检查 / 配置 / 同步 / 概览用量 + 三路主体数据源）、
// `use-model-gateway-budgets.ts` 与 `use-model-gateway-usage.ts`（各自 Tab 的状态与请求），
// 渲染落在 `model-gateway-{overview,models,budgets,usage}-panel.tsx` 与 `model-gateway-budget-dialogs.tsx`。
//
// 三个 Tab 自己的状态（模型搜索、预算筛选与勾选、用量范围）**仍由本文件持有**：拆分前它们与其余状态同处一个
// 长生命周期的组件，切走再切回不会丢；把状态搬进面板会让「离开 Tab 再回来」变成重新开始，属于行为变更。
// 本文件因此调用两个 Tab 控制器 hook（`active` 参数保留原先重查条件里的 `tab === "budgets"` 一档）。
import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import { Button } from "@fenix/ui-components/ui/button";
import { useAdminKeyGate } from "@fenix/web-runtime/hooks/use-admin-key-gate";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MODELS_NS } from "../../i18n/namespace";
import { ModelGatewayKeyManagementPanel } from "./ModelGatewayKeyManagementPanel";
import { ModelGatewayBudgetsPanel } from "./model-gateway-budgets-panel";
import { ModelGatewayModelsPanel } from "./model-gateway-models-panel";
import { OverviewPanel } from "./model-gateway-overview-panel";
import { ModelGatewayUsagePanel } from "./model-gateway-usage-panel";
import { useModelGatewayBudgets } from "./use-model-gateway-budgets";
import { useModelGatewayDashboard } from "./use-model-gateway-dashboard";
import { useModelGatewayUsage } from "./use-model-gateway-usage";
import "./AdminModelGatewayPage.css";

/** 系统模型网关管理页一期壳：模型目录仍由 LiteLLM 管理，Fenix 只负责检查和投影同步。 */
export function AdminModelGatewayPage() {
  const { t } = useTranslation(MODELS_NS);
  const gate = useAdminKeyGate(t("admin.gateAuthFailed"));

  return (
    <AdminKeyGate
      unlocked={gate.unlocked}
      error={gate.error}
      onUnlock={gate.unlock}
      title={t("admin.gateTitle")}
      description={t("admin.gateDescription")}
      inputPlaceholder={t("admin.gateInputPlaceholder")}
      submitLabel={t("admin.gateSubmit")}
    >
      <ModelGatewayDashboard onAuthFailure={gate.fail} />
    </AdminKeyGate>
  );
}

function ModelGatewayDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation(MODELS_NS);
  const {
    tab,
    setTab,
    loadTabSources,
    status,
    config,
    checking,
    syncing,
    busy,
    onCheck,
    onSync,
    overviewUsage,
    overviewLoading,
    overviewError,
    onRefreshOverview,
    organizationOptions,
    userOptions,
    agentOptions,
    onUserSearchChange,
    onAgentSearchChange,
  } = useModelGatewayDashboard({ onAuthFailure });
  const budgets = useModelGatewayBudgets({ active: tab === "budgets", onAuthFailure });
  const usage = useModelGatewayUsage();

  // 「模型」Tab 的搜索与筛选：状态留在页面（见文件头对状态生命周期的说明），派生表由面板自己算。
  const [modelSearch, setModelSearch] = useState("");
  const [modelFilter, setModelFilter] = useState("all");

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
          {(["overview", "models", "budgets", "usage", "keys"] as const).map((item) => (
            <Button
              key={item}
              variant={tab === item ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                setTab(item);
                loadTabSources(item);
              }}
            >
              {t(`modelGateway.tabs.${item}`)}
            </Button>
          ))}
        </div>

        {tab === "overview" ? (
          <OverviewPanel
            status={status}
            config={config}
            usage={overviewUsage}
            loading={overviewLoading}
            error={overviewError}
            onRefresh={onRefreshOverview}
            onModels={() => setTab("models")}
          />
        ) : tab === "keys" ? (
          <ModelGatewayKeyManagementPanel onAuthFailure={onAuthFailure} />
        ) : tab === "models" ? (
          <ModelGatewayModelsPanel
            status={status}
            config={config}
            checking={checking}
            syncing={syncing}
            busy={busy}
            modelSearch={modelSearch}
            modelFilter={modelFilter}
            onModelSearchChange={setModelSearch}
            onModelFilterChange={setModelFilter}
            onCheck={onCheck}
            onSync={onSync}
          />
        ) : tab === "budgets" ? (
          <ModelGatewayBudgetsPanel
            budgets={budgets}
            config={config}
            organizationOptions={organizationOptions}
            userOptions={userOptions}
            onUserSearchChange={onUserSearchChange}
          />
        ) : (
          <ModelGatewayUsagePanel
            usage={usage}
            models={status?.models}
            organizationOptions={organizationOptions}
            userOptions={userOptions}
            agentOptions={agentOptions}
            onUserSearchChange={onUserSearchChange}
            onAgentSearchChange={onAgentSearchChange}
          />
        )}
      </div>
    </div>
  );
}
