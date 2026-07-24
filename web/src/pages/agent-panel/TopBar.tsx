import { Bell, Search } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { GlobalSearch } from "@/components/search";
import { NS } from "@/src/i18n";

const assetBase = import.meta.env.BASE_URL;

interface TopBarProps {
  onOpenNotifications?: () => void;
  unreadCount: number;
}

/**
 * 顶部导航栏 — 平台名称、搜索入口、通知铃铛（含未读角标）。
 */
export function TopBar({ onOpenNotifications, unreadCount }: TopBarProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [searchOpen, setSearchOpen] = useState(false);

  const openSearch = useCallback(() => setSearchOpen(true), []);

  return (
    <header className="topbar">
      {/* 左侧：品牌 */}
      <div className="topbar-brand">
        <img className="topbar-logo" src={`${assetBase}brand/xsyu-emblem.png`} alt="" aria-hidden="true" />
        <span className="topbar-title">{t("topbar.platformName", "力行大模型平台")}</span>
      </div>

      {/* 右侧：操作区 */}
      <div className="topbar-actions">
        {/* 搜索入口 */}
        <button type="button" className="topbar-action-btn" onClick={openSearch} title={t("topbar.search", "搜索")}>
          <Search className="h-4 w-4" />
          <span className="topbar-search-label">{t("topbar.search", "搜索")}</span>
          <kbd className="topbar-kbd">Ctrl+K</kbd>
        </button>

        {/* 通知铃铛 */}
        <button
          type="button"
          className="topbar-bell-btn"
          onClick={onOpenNotifications}
          title={t("topbar.notifications", "通知")}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && <span className="topbar-bell-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
        </button>
      </div>

      {/* 全局搜索弹窗 */}
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </header>
  );
}
