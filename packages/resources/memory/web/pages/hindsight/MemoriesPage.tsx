import "./MemoriesPage.css";

import { AgentMasterDetailWorkspace } from "@fenix/ui-components/components/agent-master-detail-workspace";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Input } from "@fenix/ui-components/ui/input";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { Eye, Fingerprint, Globe, Lightbulb, Network, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { hindsightApi } from "../../api/hindsight";
import { DataView as HindsightDataView } from "./components/DataView";
import { EntitiesView } from "./components/EntitiesView";
import { HindsightFailureNotice } from "./components/HindsightFailureNotice";
import { MentalModelsView } from "./components/MentalModelsView";
import { toHindsightFailure } from "./failure";

type MemoryPerspective = "world" | "experience" | "observation" | "mental-models" | "entities";
type FactPerspective = Extract<MemoryPerspective, "world" | "experience" | "observation">;

const PERSPECTIVES = [
  {
    id: "world",
    icon: Globe,
    labelKey: "tabs.worldFacts",
    descriptionKey: "perspectives.worldDescription",
    markClass: "bg-sky-500",
  },
  {
    id: "experience",
    icon: Fingerprint,
    labelKey: "tabs.experience",
    descriptionKey: "perspectives.experienceDescription",
    markClass: "bg-violet-500",
  },
  {
    id: "observation",
    icon: Eye,
    labelKey: "tabs.observations",
    descriptionKey: "perspectives.observationDescription",
    markClass: "bg-amber-500",
  },
  {
    id: "mental-models",
    icon: Lightbulb,
    labelKey: "tabs.mentalModels",
    descriptionKey: "perspectives.mentalModelsDescription",
    markClass: "bg-emerald-500",
  },
  {
    id: "entities",
    icon: Network,
    labelKey: "tabs.entities",
    descriptionKey: "perspectives.entitiesDescription",
    markClass: "bg-rose-500",
  },
] as const;

function isFactPerspective(perspective: MemoryPerspective): perspective is FactPerspective {
  return perspective === "world" || perspective === "experience" || perspective === "observation";
}

export function MemoriesPage() {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [perspective, setPerspective] = useState<MemoryPerspective>("world");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // 状态取数交给 `useRequest`（§3.4）：`hindsightApi` 在域内 `unwrap()`（§5.9），失败抛 `ApiError`，
  // 因此 `error` 分支能真正接到 4xx/5xx——手写的 `try/catch` + 三个 `setState` 不再需要。
  const {
    data: status,
    loading,
    error: statusError,
    refresh: refreshStatus,
  } = useRequest(() => hindsightApi.getStatus(), {
    onError: (err) => console.error("Failed to get Hindsight status:", err),
  });

  // 失败态由 `error` 派生，而不是另存一份 state：`data` 在失败时保持 undefined，`enabled` 会落到 false。
  // 若失败没有独立分支，界面会走下面的「未配置」空态——即把取数失败伪装成产品未配置（§3.4 禁止）。
  const statusFailure = statusError ? toHindsightFailure(statusError) : null;
  const enabled = status?.enabled ?? false;

  if (loading) {
    return (
      // 骨架屏没有可朗读文本，故用 `aria-busy` 表达「区域正在取数」而不是空挂 role="status"。
      <div
        className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7"
        aria-busy="true"
      >
        <div className="mb-4 shrink-0 space-y-2">
          <Skeleton className="h-7 w-28 rounded-md" />
          <Skeleton className="h-3 w-56 rounded-md" />
        </div>
        <div className="memories-page-skeleton-grid grid min-h-0 flex-1 gap-4">
          <Skeleton className="rounded-xl" />
          <Skeleton className="rounded-xl" />
        </div>
      </div>
    );
  }

  if (statusFailure) {
    return (
      <div className="grid h-full min-h-0 place-items-center overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
        <HindsightFailureNotice
          failure={statusFailure}
          titleKey="status.loadFailed"
          retryKey="status.retry"
          onRetry={refreshStatus}
          className="py-16"
        />
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="grid h-full min-h-0 place-items-center overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
        <EmptyState className="py-16" title={t("status.notConfigured")} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
      <header className="mb-4 shrink-0">
        <h1 className="text-xl font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
      </header>

      {/*
        左栏是**视角切换 tab**（`aria-pressed` + 图标 / 标题 / 描述 / 状态色点），不是「N 条实体的目录」，
        因此只把它放进共享主从壳的 `index` 槽，不套 `AgentCatalogIndex` 一族（那族的列模板与
        `aria-current="page"` 表达的是「当前打开的那一条」，套上来会把 tab 的选中语义改写成目录语义）。
        左列的竖分隔线也不再由本页画：壳的左列自带 `shadow-[inset_-1px_0_var(--color-border)]`，与旧面板
        `md:border-r` 落在同一像素列、同用 `--color-border`；窄屏那条横向分隔线仍由下面的 `border-b` 提供。

        壳自带的高度是 `calc(100dvh - 210px)`（按宿主壳上方 210px 的老页面定的）；本页头部加留白只有约
        73px，直接沿用会在面板下方空出约 137px（1440×900 实测 690px vs 804.13px）。故这里把本页原有的高度
        分配交给壳：`flex-1` 让面板仍填满头部以下的剩余空间（与知识库页 `knowledge-workspace flex-1` 同一
        做法）；行模板、高度下限与详情高度链在 `MemoriesPage.css` 里，逐条附实测数字。
      */}
      <AgentMasterDetailWorkspace
        className="memories-page-workspace flex flex-1"
        index={
          <aside className="flex min-h-0 min-w-0 flex-col border-b p-2 md:border-b-0 md:p-3">
            <div className="hidden px-2 pb-3 md:block">
              <strong className="block text-sm">{t("perspectives.title")}</strong>
              <span className="mt-1 block text-xs text-muted-foreground">{t("perspectives.description")}</span>
            </div>

            {isFactPerspective(perspective) && (
              <form
                className="relative mb-2 md:mb-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSearchQuery(searchInput.trim());
                }}
              >
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onInput={(event) => setSearchInput(event.currentTarget.value)}
                  placeholder={t("workspace.searchPlaceholder")}
                  aria-label={t("workspace.searchPlaceholder")}
                  className="bg-background pl-9"
                />
              </form>
            )}

            <nav
              className="flex min-w-0 gap-1 overflow-x-auto pb-1 md:grid md:overflow-visible md:pb-0"
              aria-label={t("perspectives.title")}
            >
              {PERSPECTIVES.map(({ id, icon: Icon, labelKey, descriptionKey, markClass }) => {
                const selected = perspective === id;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setPerspective(id)}
                    className={`memories-page-perspective-tab grid min-h-11 shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors md:min-h-14 md:w-auto md:px-2.5 md:py-2 ${
                      selected
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-background hover:text-foreground"
                    }`}
                  >
                    <span
                      className={`relative grid size-9 place-items-center rounded-full border ring-2 ring-inset transition-colors ${
                        selected
                          ? "border-primary/40 bg-primary/10 text-primary ring-primary/25"
                          : "border-border bg-background text-muted-foreground ring-muted"
                      }`}
                      aria-hidden="true"
                    >
                      <Icon className="size-4" />
                      <span
                        className={`absolute right-0.5 bottom-0.5 size-2 rounded-full border border-background ${markClass}`}
                      />
                    </span>
                    <span className="min-w-0">
                      <strong className="block text-sm text-foreground">{t(labelKey)}</strong>
                      <small className="hidden truncate text-3xs text-muted-foreground md:block">
                        {t(descriptionKey)}
                      </small>
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>
        }
      >
        <main className="h-full min-h-0 min-w-0 overflow-hidden p-3 sm:p-5">
          {isFactPerspective(perspective) ? (
            <HindsightDataView
              key={`${perspective}:${searchQuery}`}
              factType={perspective}
              initialQuery={searchQuery}
            />
          ) : perspective === "mental-models" ? (
            <MentalModelsView />
          ) : (
            <EntitiesView />
          )}
        </main>
      </AgentMasterDetailWorkspace>
    </div>
  );
}
