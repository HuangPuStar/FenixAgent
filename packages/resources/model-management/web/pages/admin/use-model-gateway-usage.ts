/**
 * 「用量」Tab 的状态与请求：`ModelGatewayUsagePanel` 的控制器。
 *
 * §4.7 拆分（2026-09-23）：这一段原先与其余四块的状态挤在 `ModelGatewayDashboard` 的 20 个 `useState` 里，
 * 与用量 JSX 相隔数百行。范围（近 30 天 / 近 7 天 / 自定义起止）与四路筛选只被用量 Tab 消费，随本模块走。
 *
 * 形态是 hook 而不是面板内的 `useState`：本 hook 由 Dashboard 调用，状态因此**仍活过「切走再切回」**
 * （与拆分前一致）——搬进面板会让回来时范围、筛选与已查结果全部重置，那是行为变更。用户 / 组织 / Agent
 * 三路下拉由 `useModelGatewayDashboard` 编排（预算 Tab 也用其中两路），不在本模块内。
 *
 * 请求本身**没有失败分支**（与拆分前一致）：用量页的 401 由 `ModelGatewayUsagePage` 单独处理，
 * 本页只在没有数据时给一行「请先查询」提示。
 */
import { useRequest } from "ahooks";
import { useState } from "react";
import { queryModelGatewayUsage } from "../../api/model-gateway";
import { buildRecentUsageDateRange } from "../../lib/model-gateway-usage";

export function useModelGatewayUsage() {
  const [usageRange, setUsageRange] = useState("30d");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [usageFilters, setUsageFilters] = useState({
    userId: "",
    organizationId: "",
    agentConfigId: "",
    modelId: "",
  });

  const usageRequest = useRequest(
    () => {
      const range =
        usageRange === "custom"
          ? { startAt: customStart, endAt: customEnd }
          : buildRecentUsageDateRange(Number(usageRange.replace("d", "")));
      return queryModelGatewayUsage({
        ...range,
        includeBreakdowns: true,
        ...Object.fromEntries(Object.entries(usageFilters).filter(([, value]) => value.trim())),
      });
    },
    { manual: true },
  );

  return {
    usageRange,
    setUsageRange,
    customStart,
    setCustomStart,
    customEnd,
    setCustomEnd,
    usageFilters,
    setUsageFilters,
    usageRequest,
  };
}

/** 面板的入参形状：状态与请求由 hook 提供，`ModelGatewayUsagePanel` 据此只做渲染。 */
export type ModelGatewayUsageController = ReturnType<typeof useModelGatewayUsage>;
