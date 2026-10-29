import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fenix/ui-components/ui/tabs";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Info } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChannelBotsView } from "./channel-bots-view";
import { ChannelDiagnosticsView } from "./channel-diagnostics-view";

const CHANNELS_TABS = ["bots", "diagnostics"] as const;
type ChannelsTab = (typeof CHANNELS_TABS)[number];

function isChannelsTab(value: string): value is ChannelsTab {
  return (CHANNELS_TABS as readonly string[]).includes(value);
}

/**
 * 消息通道页：通道树与诊断两个视图共用一页。
 *
 * 路由挂在通道下作为树的子行，不再单独成页签：一条路由离开它的通道就没有意义，分成两页会让用户
 * 在 channelId 之间来回对照。诊断取的是另一套数据（连通性与会话映射），仍独立取数，避免它的失败
 * 拖垮通道树。
 */
export function AgentChannelsPage() {
  const { t } = useTranslation(NS.CHANNELS);
  const [tab, setTab] = useState<ChannelsTab>("bots");

  return (
    <AppPage>
      <AppHeader title={t("langbot.title")} subtitle={t("langbot.subtitle")} />

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-border-subtle bg-surface-1 px-4 py-3">
        <Info className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
        <p className="text-xs leading-5 text-text-muted">{t("langbot.identityNotice")}</p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (isChannelsTab(value)) setTab(value);
        }}
        className="mt-4"
      >
        <TabsList aria-label={t("langbot.tabs.label")}>
          <TabsTrigger value="bots">{t("langbot.tabs.bots")}</TabsTrigger>
          <TabsTrigger value="diagnostics">{t("langbot.tabs.diagnostics")}</TabsTrigger>
        </TabsList>
        <TabsContent value="bots">
          <ChannelBotsView />
        </TabsContent>
        <TabsContent value="diagnostics">
          <ChannelDiagnosticsView />
        </TabsContent>
      </Tabs>
    </AppPage>
  );
}
