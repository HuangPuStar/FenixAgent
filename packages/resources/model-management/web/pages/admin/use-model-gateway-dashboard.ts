/**
 * 模型网关管理页（`AdminModelGatewayPage`）的**跨 Tab 编排**：检查 / 配置 / 同步 / 概览用量四个请求，
 * 以及三个主体下拉数据源（用户 / Agent / 组织）。
 *
 * §4.7 拆分（2026-09-23）：原先把十个 `useRequest`、四个 Tab 的 JSX 与概览面板挤在一个 1251 行的文件里，
 * 「页面 + 数据编排 + 传输适配」三类职责互相看不见边界。这里只承接**被多个 Tab 共享的那部分**：
 *   - 检查结果（`status`）与配置：概览、模型、预算、用量四块都要读；
 *   - 用户 / 组织两路主体数据：预算与用量两个 Tab 共用（含「切到该 Tab 才拉、输入 3 秒静默后才查、
 *     新关键词先取消旧请求」三条既有策略）；
 *   - 鉴权失效的归一：`UNAUTHORIZED` 才清 Master Key，网关或数据库故障不能被误判（原逻辑逐字保留）。
 * 各 Tab 自己的状态与请求随各自的面板走——预算的筛选 / 分页 / 勾选 / 弹窗在
 * `model-gateway-budgets-panel.tsx`，用量的范围 / 四路筛选在 `model-gateway-usage-panel.tsx`。
 *
 * 选择器选项在这里拼装（预算与用量此前各拼一份同款标签），两个面板因此只收 `{ value, label }[]`。
 */
import { systemPeopleTreeApi } from "@fenix/resource-observer/web";
import { ApiError } from "@fenix/web-runtime/api/request";
import { useDebounce, useRequest } from "ahooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type ModelSyncStatus, modelGatewayApi } from "../../api/model-gateway";
import { MODELS_NS } from "../../i18n/namespace";
import { getModelGatewayConnectionFeedback } from "./model-gateway-feedback";
import { buildModelGatewayOverviewUsageQuery } from "./model-gateway-overview";

/** 五个 Tab 的键：顺序即 Tab 条的呈现顺序。 */
export type ModelGatewayTab = "overview" | "models" | "budgets" | "usage" | "keys";

/** `SearchableUsageFilter` 的选项形状（本页的标签口径统一在这里拼一次）。 */
export interface ModelGatewayFilterOption {
  value: string;
  label: string;
}

export function useModelGatewayDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation(MODELS_NS);
  const [status, setStatus] = useState<ModelSyncStatus | null>(null);
  const [tab, setTab] = useState<ModelGatewayTab>("overview");
  const [userSearchKeyword, setUserSearchKeyword] = useState<string | null>(null);
  const [agentSearchKeyword, setAgentSearchKeyword] = useState<string | null>(null);

  const handleGatewayRequestError = (error: Error) => {
    // 只有系统 API 明确返回未授权时才清理 Master Key；网关或数据库故障不能被误判为鉴权失败。
    if (error instanceof ApiError && error.code === "UNAUTHORIZED") {
      onAuthFailure();
    }
  };

  const checkRequest = useRequest(() => modelGatewayApi.check(), {
    manual: true,
    onSuccess: setStatus,
    onError: handleGatewayRequestError,
  });
  const configRequest = useRequest(() => modelGatewayApi.getConfiguration(), {
    manual: true,
    onError: handleGatewayRequestError,
  });
  const syncRequest = useRequest(() => modelGatewayApi.sync(), {
    manual: true,
    onSuccess: () => {
      setStatus((current) => (current ? { ...current, status: "synced", changes: [] } : current));
      void checkRequest.run();
    },
    onError: handleGatewayRequestError,
  });
  const usersRequest = useRequest((keyword?: string) => modelGatewayApi.listUsers(keyword?.trim() ? { keyword } : {}), {
    manual: true,
  });
  const agentsRequest = useRequest(
    (keyword?: string) => modelGatewayApi.listAgents(keyword?.trim() ? { keyword } : {}),
    {
      manual: true,
    },
  );
  const organizationsRequest = useRequest(() => systemPeopleTreeApi.fetchTree(), {
    manual: true,
    onError: handleGatewayRequestError,
  });
  const overviewUsageRequest = useRequest(() => modelGatewayApi.queryUsage(buildModelGatewayOverviewUsageQuery()), {
    manual: true,
    onError: handleGatewayRequestError,
  });

  const checking = checkRequest.loading;
  const syncing = syncRequest.loading;
  const busy = checking || syncing;

  async function runConnectionCheck(): Promise<void> {
    try {
      const result = await checkRequest.runAsync();
      const feedback = getModelGatewayConnectionFeedback(result);
      if (feedback.level === "success") toast.success(t(feedback.translationKey, feedback.values));
      else toast.error(t(feedback.translationKey, feedback.values));
    } catch (error) {
      // 上屏只给字典文案（§9.3）：`ApiError.message` 是后端错误信封原文，只进这里。
      console.error("[model-gateway] connection check failed", error);
      toast.error(t("modelGateway.connectionCheck.requestFailed"));
    }
  }

  useEffect(() => {
    void checkRequest.run();
    void configRequest.run();
    void overviewUsageRequest.run();
  }, [checkRequest.run, configRequest.run, overviewUsageRequest.run]);

  // 主体搜索走后端关键词查询：3 秒静默后才发起请求，避免输入时持续压测系统 API。
  // 防抖交给 ahooks 的 `useDebounce`（本包与仓库根依赖的 ahooks@^3.9.7），不再手写 setTimeout + clearTimeout
  // 两遍；Agent 与用户共用同一策略，旧请求先取消，避免慢响应覆盖最新关键词结果。
  const debouncedUserSearchKeyword = useDebounce(userSearchKeyword, { wait: 3000 });
  const debouncedAgentSearchKeyword = useDebounce(agentSearchKeyword, { wait: 3000 });

  useEffect(() => {
    if (debouncedUserSearchKeyword === null) return;
    void usersRequest.run(debouncedUserSearchKeyword.trim());
  }, [debouncedUserSearchKeyword, usersRequest.run]);

  useEffect(() => {
    if (debouncedAgentSearchKeyword === null) return;
    void agentsRequest.run(debouncedAgentSearchKeyword.trim());
  }, [debouncedAgentSearchKeyword, agentsRequest.run]);

  const organizationOptions: ModelGatewayFilterOption[] = (organizationsRequest.data?.organizations ?? []).map(
    (organization) => ({
      value: organization.id,
      label: `${organization.name}（${organization.id}）`,
    }),
  );
  const userOptions: ModelGatewayFilterOption[] = (usersRequest.data?.items ?? []).map((user) => ({
    value: user.id,
    label: t("modelGateway.usagePage.userOption", { name: user.name, email: user.email }),
  }));
  const agentOptions: ModelGatewayFilterOption[] = (agentsRequest.data ?? []).map((item) => ({
    value: item.id,
    label: `${
      organizationsRequest.data?.organizations.find((organization) => organization.id === item.organizationId)?.name ??
      item.organizationId
    } / ${item.name}`,
  }));

  /** 切到预算 / 用量 Tab 时补齐各自要用的数据源（两 Tab 共用用户与组织，已有数据就不再拉）。 */
  const loadTabSources = (nextTab: ModelGatewayTab) => {
    if (nextTab === "budgets") {
      if (!usersRequest.data) void usersRequest.run();
      if (!organizationsRequest.data) void organizationsRequest.run();
    }
    if (nextTab === "usage") {
      if (!agentsRequest.data) void agentsRequest.run();
      if (!usersRequest.data) void usersRequest.run();
      if (!organizationsRequest.data) void organizationsRequest.run();
    }
  };

  const onUserSearchChange = (keyword: string) => {
    usersRequest.cancel();
    setUserSearchKeyword(keyword);
  };
  const onAgentSearchChange = (keyword: string) => {
    agentsRequest.cancel();
    setAgentSearchKeyword(keyword);
  };

  return {
    tab,
    setTab,
    loadTabSources,
    status,
    config: configRequest.data,
    checking,
    syncing,
    busy,
    onCheck: runConnectionCheck,
    onSync: () => syncRequest.run(),
    overviewUsage: overviewUsageRequest.data,
    overviewLoading: checkRequest.loading || overviewUsageRequest.loading,
    overviewError: checkRequest.error ?? overviewUsageRequest.error,
    onRefreshOverview: () => {
      void runConnectionCheck();
      void overviewUsageRequest.run();
    },
    organizationOptions,
    userOptions,
    agentOptions,
    onUserSearchChange,
    onAgentSearchChange,
  };
}
