import { AlertCircle, Eye, Fingerprint, Globe, Lightbulb, Network, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { hindsightApi } from "@/src/api/hindsight";
import { WorkbenchPanel } from "@/src/components/agent-panel/WorkbenchPanel";
import { NS } from "@/src/i18n";
import { DataView as HindsightDataView } from "./components/DataView";
import { EntitiesView } from "./components/EntitiesView";
import { MentalModelsView } from "./components/MentalModelsView";

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
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [perspective, setPerspective] = useState<MemoryPerspective>("world");
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setStatusError(false);
    try {
      const status = await hindsightApi.getStatus();
      setEnabled(status.enabled);
    } catch (error) {
      console.error("Failed to get Hindsight status:", error);
      setStatusError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
        <div className="mb-4 shrink-0 space-y-2">
          <Skeleton className="h-7 w-28 rounded-md" />
          <Skeleton className="h-3 w-56 rounded-md" />
        </div>
        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
          <Skeleton className="rounded-xl" />
          <Skeleton className="rounded-xl" />
        </div>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="grid h-full min-h-0 place-items-center overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" role="alert">
          <AlertCircle className="size-8 text-destructive" />
          <p className="text-sm font-medium">{t("status.loadFailed")}</p>
          <Button variant="outline" size="sm" onClick={() => void loadStatus()} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            {t("status.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="grid h-full min-h-0 place-items-center overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <p className="text-sm">{t("status.notConfigured")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
      <header className="mb-4 shrink-0">
        <h1 className="text-[22px] font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
      </header>

      <WorkbenchPanel className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-1">
        <aside className="flex min-h-0 min-w-0 flex-col border-b bg-muted/30 p-2 md:p-3 md:border-r md:border-b-0">
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
                  className={`grid min-h-11 shrink-0 grid-cols-[2.25rem_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors md:min-h-14 md:w-auto md:grid-cols-[2.25rem_minmax(0,1fr)] md:px-2.5 md:py-2 ${
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
                    <small className="hidden truncate text-[11px] text-muted-foreground md:block">
                      {t(descriptionKey)}
                    </small>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

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
      </WorkbenchPanel>
    </div>
  );
}
