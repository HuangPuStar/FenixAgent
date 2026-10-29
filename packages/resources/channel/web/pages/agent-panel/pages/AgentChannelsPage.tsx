import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChannelBotsView } from "./channel-bots-view";

/**
 * 消息通道页：只有通道树一个能力。
 *
 * 诊断（LangBot 连通性、通道/会话表）已迁到管理台的「消息通道」页：它的数据口径是全部组织，而本页的
 * 控制面接口按 active organization 过滤，留在登录态页面上只能看到当前组织的切片，排障时会误导。
 */
export function AgentChannelsPage() {
  const { t } = useTranslation(NS.CHANNELS);

  return (
    <AppPage>
      <AppHeader title={t("langbot.title")} subtitle={t("langbot.subtitle")} />

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-border-subtle bg-surface-1 px-4 py-3">
        <Info className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden="true" />
        <p className="text-xs leading-5 text-text-muted">{t("langbot.identityNotice")}</p>
      </div>

      <div className="mt-4">
        <ChannelBotsView />
      </div>
    </AppPage>
  );
}
