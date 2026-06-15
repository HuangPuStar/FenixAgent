import { Brain, Eye, Fingerprint, Globe, Lightbulb, Network } from "lucide-react";
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
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">{t("status.loading")}</p>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">{t("status.notConfigured")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 页面标题 */}
      <div className="px-6 py-4 border-b">
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Brain className="w-5 h-5" />
          {t("title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t("description")}</p>
      </div>

      {/* 主 Tab：每个 factType 一个 tab，DataView 内部有 4 种布局切换 */}
      <Tabs defaultValue="world" className="flex-1 flex flex-col min-h-0">
        <div className="px-6 border-b">
          <TabsList>
            <TabsTrigger value="world">
              <Globe className="w-4 h-4 mr-1.5" />
              {t("tabs.worldFacts")}
            </TabsTrigger>
            <TabsTrigger value="experience">
              <Fingerprint className="w-4 h-4 mr-1.5" />
              {t("tabs.experience")}
            </TabsTrigger>
            <TabsTrigger value="observation">
              <Eye className="w-4 h-4 mr-1.5" />
              {t("tabs.observations")}
            </TabsTrigger>
            <TabsTrigger value="mental-models">
              <Lightbulb className="w-4 h-4 mr-1.5" />
              {t("tabs.mentalModels")}
            </TabsTrigger>
            <TabsTrigger value="entities">
              <Network className="w-4 h-4 mr-1.5" />
              {t("tabs.entities")}
            </TabsTrigger>
          </TabsList>
        </div>

        {/* 前 3 个 tab 使用 DataView，内部有 Constellation/Graph/Table/Timeline 切换 */}
        <TabsContent value="world" className="flex-1 min-h-0 overflow-auto p-4">
          <HindsightDataView factType="world" />
        </TabsContent>
        <TabsContent value="experience" className="flex-1 min-h-0 overflow-auto p-4">
          <HindsightDataView factType="experience" />
        </TabsContent>
        <TabsContent value="observation" className="flex-1 min-h-0 overflow-auto p-4">
          <HindsightDataView factType="observation" />
        </TabsContent>
        <TabsContent value="mental-models" className="flex-1 min-h-0 overflow-auto p-4">
          <MentalModelsView />
        </TabsContent>
        <TabsContent value="entities" className="flex-1 min-h-0 overflow-auto p-4">
          <EntitiesView />
        </TabsContent>
      </Tabs>
    </div>
  );
}
