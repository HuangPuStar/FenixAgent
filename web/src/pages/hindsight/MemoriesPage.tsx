import { Eye, Fingerprint, Globe, Lightbulb, Network } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
        setEnabled(res.data.enabled);
      })
      .catch((err) => {
        console.error("Failed to get Hindsight status:", err);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-full items-center justify-center bg-[#f4f7fb]">
        <p className="text-[#94a3b8]">{t("status.loading")}</p>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="flex min-h-full items-center justify-center bg-[#f4f7fb]">
        <p className="text-[#94a3b8]">{t("status.notConfigured")}</p>
      </div>
    );
  }

  return (
    <Tabs defaultValue="world" className="flex min-h-full flex-col bg-[#f4f7fb] text-[#14213d]">
      {/* 标题行：标题 + 副标题在左，Tab 选择器在右 */}
      <div className="shrink-0 px-8 pt-7">
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
        <div className="h-px bg-[#e8edf4]" />
      </div>

      <TabsContent value="world" className="min-h-0 flex-1 overflow-auto p-4">
        <HindsightDataView factType="world" />
      </TabsContent>
      <TabsContent value="experience" className="min-h-0 flex-1 overflow-auto p-4">
        <HindsightDataView factType="experience" />
      </TabsContent>
      <TabsContent value="observation" className="min-h-0 flex-1 overflow-auto p-4">
        <HindsightDataView factType="observation" />
      </TabsContent>
      <TabsContent value="mental-models" className="min-h-0 flex-1 overflow-auto p-4">
        <MentalModelsView />
      </TabsContent>
      <TabsContent value="entities" className="min-h-0 flex-1 overflow-auto p-4">
        <EntitiesView />
      </TabsContent>
    </Tabs>
  );
}
