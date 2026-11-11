import { Gauge } from "lucide-react";
import { AGENT_CONCURRENCY_NS } from "./i18n/namespace";

/** Runtime 向系统管理 Shell 贡献并发配置入口；布局及顺序仍由 Shell 持有。 */
export const agentConcurrencyAdminNavigation = {
  to: "/admin/agent-concurrency",
  labelKey: "title",
  ns: AGENT_CONCURRENCY_NS,
  icon: Gauge,
} as const;
