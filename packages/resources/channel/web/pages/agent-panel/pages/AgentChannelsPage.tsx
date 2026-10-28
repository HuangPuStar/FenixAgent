import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fenix/ui-components/ui/tabs";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Info } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChannelBotsView } from "./channel-bots-view";
import { ChannelDiagnosticsView } from "./channel-diagnostics-view";
import { ChannelRoutesView } from "./channel-routes-view";

const CHANNELS_TABS = ["bots", "routes", "diagnostics"] as const;
type ChannelsTab = (typeof CHANNELS_TABS)[number];

function isChannelsTab(value: string): value is ChannelsTab {
  return (CHANNELS_TABS as readonly string[]).includes(value);
}

/**
 * 消息通道页：通道 / 路由 / 诊断三个视图共用一页。
 *
 * 三个视图各自取数、各自维护弹窗状态，容器只负责页签与执行身份提示——通道配置、路由规则和
 * 会话映射的刷新节奏互不相同，合成一个请求只会让某一块的失败拖垮整页。
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
          <TabsTrigger value="routes">{t("langbot.tabs.routes")}</TabsTrigger>
          <TabsTrigger value="diagnostics">{t("langbot.tabs.diagnostics")}</TabsTrigger>
        </TabsList>
        <TabsContent value="bots">
          <ChannelBotsView />
        </TabsContent>
        <TabsContent value="routes">
          <ChannelRoutesView onGoToBots={() => setTab("bots")} />
        </TabsContent>
        <TabsContent value="diagnostics">
          <ChannelDiagnosticsView />
        </TabsContent>
      </Tabs>
    </AppPage>
  );
}
