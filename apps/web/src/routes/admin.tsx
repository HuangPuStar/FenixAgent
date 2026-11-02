import { MODELS_NS } from "@fenix/model-management/web/i18n";
import { CHANNELS_NS } from "@fenix/resource-channel/web/i18n";
import { PLUGIN_MARKET_NS } from "@fenix/resource-plugin-market/web/i18n";
import { SANDBOX_NS } from "@fenix/resource-sandbox/web/i18n";
import { TICKETS_NS } from "@fenix/resource-tickets/web/i18n";
import { cn } from "@fenix/ui-components/lib/cn";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeft,
  Box,
  FileText,
  Gauge,
  type LucideIcon,
  MessageSquare,
  Network,
  Package,
  Ticket,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAssemblyCapabilities } from "@/src/shell/AssemblyCapabilitiesProvider";

// Admin 布局（docs/arch/21 §5）：左侧边栏导航 + 内容区 Outlet。
// 导航项数组是扩展点：后续新增 admin 子页面时在此追加 { to, labelKey, ns, icon, moduleId? }。
// `labelKey` 默认落在 observer 命名空间（布局自有的 admin/logs/people 页），跨包页面必须用 `ns` 指向
// 键的 owner：`nav` 与 `modelGateway.nav` 随页面一起迁入 sandbox / model-management 包后，不再存在于
// observer 字典里（继续按 observer 读会直接把 key 回显到导航上）。Obs 保持为默认首页（/admin）。
// `ns` 取值一律来自 owner 包导出的常量；此处只用 `string` 而不是中心表的 `Namespace` 联合类型，因为
// `SANDBOX` 尚未登记进 `@fenix/web-runtime/i18n/namespace`。
//
// `moduleId` 是**可选**的部署能力键：不声明表示「本 profile 下一定存在」（observer / sandbox /
// model-management / plugin-market 都随默认组合交付，它们的管理页今天没有装配门）。工单不同——默认
// `ce.json` 连它的 web 贡献都不在产物里，因此必须按 `useAssemblyCapabilities()` 收窄：没有这一层，
// 默认产物会在侧栏里亮出一个点进去只会显示「未启用」的条目。
const NAV_ITEMS: {
  to:
    | "/admin"
    | "/admin/logs"
    | "/admin/people"
    | "/admin/channels"
    | "/admin/sandbox"
    | "/admin/model-gateway"
    | "/admin/plugin-market"
    | "/admin/tickets";
  labelKey: string;
  ns?: string;
  icon: LucideIcon;
  moduleId?: string;
}[] = [
  { to: "/admin", labelKey: "title", icon: Activity },
  { to: "/admin/sandbox", labelKey: "nav", ns: SANDBOX_NS, icon: Box },
  // 消息通道的跨组织面：控制台的 `/agent/channels` 按当前组织过滤，这里给系统 key 面看全部通道与会话实例。
  { to: "/admin/channels", labelKey: "langbot.admin.nav", ns: CHANNELS_NS, icon: MessageSquare },
  { to: "/admin/people", labelKey: "people.nav", icon: Network },
  { to: "/admin/model-gateway", labelKey: "modelGateway.nav", ns: MODELS_NS, icon: Gauge },
  // 插件市场的管理面（发布 / 下架 / 恢复）：控制台那一份是只读浏览（`/agent/mcp?tab=npm`），
  // 写入口只在这里——两处不是同一个页面的两个入口，而是两种凭据下的两种能力。
  { to: "/admin/plugin-market", labelKey: "admin.nav", ns: PLUGIN_MARKET_NS, icon: Package },
  // 工单的跨组织面（列表 + 详情与全部写入口，系统 key 面）：控制台那一份按当前组织过滤，两种凭据对应两种可见范围。
  { to: "/admin/tickets", labelKey: "admin.nav", ns: TICKETS_NS, icon: Ticket, moduleId: "tickets" },
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
  const { enabled } = useAssemblyCapabilities();
  // 装配清单拉取失败时 `enabled` 是构建期上界（fail-open，见 `AssemblyCapabilitiesProvider`），因此这里
  // 只会隐藏「产物里本来就没有」的条目，不会因为一次网络抖动把已启用的入口藏起来。
  const items = NAV_ITEMS.filter((item) => item.moduleId === undefined || enabled.has(item.moduleId));
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-10 flex w-56 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-2 px-4 py-4">
          <Activity className="size-4 text-text-muted" />
          <span className="text-sm font-semibold text-text-primary">{t("admin.title")}</span>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2">
          {items.map((item) => (
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
