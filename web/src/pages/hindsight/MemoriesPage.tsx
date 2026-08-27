import { AlertCircle, Eye, Fingerprint, Globe, Lightbulb, Network, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { hindsightApi } from "@/src/api/hindsight";
import { NS } from "@/src/i18n";
import { DataView as HindsightDataView } from "./components/DataView";
import { EntitiesView } from "./components/EntitiesView";
import { MentalModelsView } from "./components/MentalModelsView";

type MemoryPerspective = "world" | "experience" | "observation" | "mental-models" | "entities";
type FactPerspective = Extract<MemoryPerspective, "world" | "experience" | "observation">;

const PERSPECTIVES = [
  { id: "world", icon: Globe, labelKey: "tabs.worldFacts", descriptionKey: "perspectives.worldDescription" },
  {
    id: "experience",
    icon: Fingerprint,
    labelKey: "tabs.experience",
    descriptionKey: "perspectives.experienceDescription",
  },
  {
    id: "observation",
    icon: Eye,
    labelKey: "tabs.observations",
    descriptionKey: "perspectives.observationDescription",
  },
  {
    id: "mental-models",
    icon: Lightbulb,
    labelKey: "tabs.mentalModels",
    descriptionKey: "perspectives.mentalModelsDescription",
  },
  { id: "entities", icon: Network, labelKey: "tabs.entities", descriptionKey: "perspectives.entitiesDescription" },
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
      <div className="min-h-full overflow-auto bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
        <div className="mb-4 space-y-2">
          <Skeleton className="h-7 w-28 rounded-md" />
          <Skeleton className="h-3 w-56 rounded-md" />
        </div>
        <div className="grid min-h-[36rem] gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
          <Skeleton className="rounded-xl" />
          <Skeleton className="rounded-xl" />
        </div>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="min-h-full overflow-auto bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
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
      <div className="min-h-full overflow-auto bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <p className="text-sm">{t("status.notConfigured")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-muted/30 px-4 py-5 text-foreground sm:px-8 sm:py-7">
      <header className="mb-4">
        <h1 className="text-[22px] font-bold tracking-tight">{t("title")}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("description")}</p>
      </header>

      <div className="grid min-h-[36rem] overflow-hidden rounded-xl border bg-background shadow-sm md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col border-b bg-muted/30 p-3 md:border-r md:border-b-0">
          <div className="px-2 pb-3">
            <strong className="block text-sm">{t("perspectives.title")}</strong>
            <span className="mt-1 block text-xs text-muted-foreground">{t("perspectives.description")}</span>
          </div>

          {isFactPerspective(perspective) && (
            <form
              className="relative mb-3"
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

          <nav className="grid gap-1" aria-label={t("perspectives.title")}>
            {PERSPECTIVES.map(({ id, icon: Icon, labelKey, descriptionKey }) => {
              const selected = perspective === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setPerspective(id)}
                  className={`grid min-h-14 grid-cols-[2rem_minmax(0,1fr)] items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    selected
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-background hover:text-foreground"
                  }`}
                >
                  <span className="grid size-8 place-items-center rounded-md bg-background shadow-sm">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <strong className="block text-sm text-foreground">{t(labelKey)}</strong>
                    <small className="block truncate text-[11px] text-muted-foreground">{t(descriptionKey)}</small>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 p-3 sm:p-5">
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
      </div>
    </div>
  );
}
