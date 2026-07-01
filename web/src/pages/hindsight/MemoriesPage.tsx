import { Eye, Fingerprint, Globe, Lightbulb, Network } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { hindsightApi } from "@/src/api/hindsight";
import { NS } from "@/src/i18n";
import { DataView as HindsightDataView } from "./components/DataView";
import { EntitiesView } from "./components/EntitiesView";
import { MentalModelsView } from "./components/MentalModelsView";

export function MemoriesPage() {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    hindsightApi
      .getStatus()
      .then((res) => {
        setEnabled(res.enabled);
      })
      .catch((err) => {
        console.error("Failed to get Hindsight status:", err);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <Skeleton className="h-[22px] w-28 rounded-md" />
            <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
          </div>
          <Skeleton className="h-9 w-64 rounded-lg" />
        </div>
        <div className="mb-3.5 h-px bg-[#e8edf4]" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <div className="flex flex-col items-center justify-center py-16 text-text-muted">
          <p className="text-sm">{t("status.notConfigured")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <Tabs defaultValue="world">
        {/* 标题行：标题 + 副标题在左，Tab 选择器在右 */}
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-bold tracking-tight text-[#1a2944]">
              {t("title")}
            </h1>
            <p className="mt-0.5 text-[12px] text-[#94a3b8]">{t("description")}</p>
          </div>
          <TabsList>
            <TabsTrigger value="world">
              <Globe className="mr-1.5 h-4 w-4" />
              {t("tabs.worldFacts")}
            </TabsTrigger>
            <TabsTrigger value="experience">
              <Fingerprint className="mr-1.5 h-4 w-4" />
              {t("tabs.experience")}
            </TabsTrigger>
            <TabsTrigger value="observation">
              <Eye className="mr-1.5 h-4 w-4" />
              {t("tabs.observations")}
            </TabsTrigger>
            <TabsTrigger value="mental-models">
              <Lightbulb className="mr-1.5 h-4 w-4" />
              {t("tabs.mentalModels")}
            </TabsTrigger>
            <TabsTrigger value="entities">
              <Network className="mr-1.5 h-4 w-4" />
              {t("tabs.entities")}
            </TabsTrigger>
          </TabsList>
        </div>

        <div className="mb-3.5 h-px bg-[#e8edf4]" />

        <TabsContent value="world" className="p-4">
          <HindsightDataView factType="world" />
        </TabsContent>
        <TabsContent value="experience" className="p-4">
          <HindsightDataView factType="experience" />
        </TabsContent>
        <TabsContent value="observation" className="p-4">
          <HindsightDataView factType="observation" />
        </TabsContent>
        <TabsContent value="mental-models" className="p-4">
          <MentalModelsView />
        </TabsContent>
        <TabsContent value="entities" className="p-4">
          <EntitiesView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
