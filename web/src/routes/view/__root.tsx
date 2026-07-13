import { createFileRoute, Outlet } from "@tanstack/react-router";
import { OrgProvider } from "../../contexts/OrgContext";

/**
 * ProdView 路由组根 layout：
 * - 全局 __root.tsx 已处理认证（无 session 自动跳 /login）
 * - 这里只注入 OrgProvider（根 layout 不提供）
 * - 无 Sidebar / ChatArea / 管理 UI
 */
export const Route = createFileRoute("/view/__root")({
  component: () => (
    <OrgProvider>
      <Outlet />
    </OrgProvider>
  ),
});
