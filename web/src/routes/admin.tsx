import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Activity, ArrowLeft, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";

// Admin 布局（docs/arch/21 §5）：左侧边栏导航 + 内容区 Outlet。
// 导航项数组是扩展点：后续新增 admin 子页面时在此追加 { to, labelKey, icon }，
// labelKey 落在 observer i18n 命名空间下；Obs 保持为默认首页（/admin）。
const NAV_ITEMS: { to: "/admin"; labelKey: string; icon: LucideIcon }[] = [
  { to: "/admin", labelKey: "title", icon: Activity },
];

const NAV_ITEM_CLASS =
  "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-accent hover:text-text-primary";
const NAV_ITEM_ACTIVE_CLASS = "bg-brand/10 text-text-primary ring-1 ring-brand/40";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  const { t } = useTranslation("observer");
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-10 flex w-56 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-2 px-4 py-4">
          <Activity className="size-4 text-text-muted" />
          <span className="text-sm font-semibold text-text-primary">{t("admin.title")}</span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: true }}
              className={NAV_ITEM_CLASS}
              activeProps={{ className: cn(NAV_ITEM_CLASS, NAV_ITEM_ACTIVE_CLASS) }}
            >
              <item.icon className="size-4" />
              {t(item.labelKey)}
            </Link>
          ))}
        </nav>
        <div className="border-t border-border p-2">
          <Link to="/agent" className={NAV_ITEM_CLASS}>
            <ArrowLeft className="size-4" />
            {t("admin.backToConsole")}
          </Link>
        </div>
      </aside>
      <main className="ml-56 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
