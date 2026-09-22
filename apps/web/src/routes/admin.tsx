import { MODELS_NS } from "@fenix/model-management/web/i18n";
import { SANDBOX_NS } from "@fenix/resource-sandbox/web/i18n";
import { cn } from "@fenix/ui-components/lib/cn";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { Activity, ArrowLeft, Box, FileText, Gauge, type LucideIcon, Network } from "lucide-react";
import { useTranslation } from "react-i18next";

// Admin 布局（docs/arch/21 §5）：左侧边栏导航 + 内容区 Outlet。
// 导航项数组是扩展点：后续新增 admin 子页面时在此追加 { to, labelKey, ns, icon }。
// `labelKey` 默认落在 observer 命名空间（布局自有的 admin/logs/people 页），跨包页面必须用 `ns` 指向
// 键的 owner：`nav` 与 `modelGateway.nav` 随页面一起迁入 sandbox / model-management 包后，不再存在于
// observer 字典里（继续按 observer 读会直接把 key 回显到导航上）。Obs 保持为默认首页（/admin）。
// `ns` 取值一律来自 owner 包导出的常量；此处只用 `string` 而不是中心表的 `Namespace` 联合类型，因为
// `SANDBOX` 尚未登记进 `@fenix/web-runtime/i18n/namespace`。
const NAV_ITEMS: {
  to: "/admin" | "/admin/logs" | "/admin/people" | "/admin/sandbox" | "/admin/model-gateway";
  labelKey: string;
  ns?: string;
  icon: LucideIcon;
}[] = [
  { to: "/admin", labelKey: "title", icon: Activity },
  { to: "/admin/sandbox", labelKey: "nav", ns: SANDBOX_NS, icon: Box },
  { to: "/admin/people", labelKey: "people.nav", icon: Network },
  { to: "/admin/model-gateway", labelKey: "modelGateway.nav", ns: MODELS_NS, icon: Gauge },
  { to: "/admin/logs", labelKey: "logs.nav", icon: FileText },
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
              {item.ns ? t(item.labelKey, { ns: item.ns }) : t(item.labelKey)}
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
