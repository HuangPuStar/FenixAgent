import { getAgentConfigConfig } from "../config";

/**
 * 控制台侧边栏的公开配置。
 *
 * 值来自宿主注入的模块配置（`APP_HIDDEN_SIDEBAR_TABS` 的原始值），本文件不做环境变量读取：迁移前
 * 直读运行环境的写法属 1.3 静态条件 4 要切断的宿主内部耦合（原因见 `src/server/config.ts`）。
 */

export interface SidebarConfig {
  hiddenTabs: string[];
}

/**
 * 返回当前系统前端侧边栏的公开展示配置。
 */
export function getSidebarConfig(): SidebarConfig {
  return { hiddenTabs: parseHiddenSidebarTabs(getAgentConfigConfig().hiddenSidebarTabs) };
}

/**
 * 把逗号分隔的 tab id 列表解析为去重后的稳定数组。
 *
 * 刻意不校验 id 是否已知：隐藏哪些 tab 由部署方决定，前端的 tab 集合会演进，未知 id 只是"当前没有
 * 对应 tab"而不是配置错误；在这里拒绝会让升级后的旧配置整体失效。
 */
export function parseHiddenSidebarTabs(rawValue: string | undefined): string[] {
  if (!rawValue?.trim()) return [];

  const uniqueTabs = new Set<string>();
  for (const rawTabId of rawValue.split(",")) {
    const tabId = rawTabId.trim();
    if (!tabId) continue;
    uniqueTabs.add(tabId);
  }

  return [...uniqueTabs];
}
