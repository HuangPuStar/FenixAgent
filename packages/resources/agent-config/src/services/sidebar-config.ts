export interface SidebarConfig {
  hiddenTabs: string[];
}

/**
 * Returns the public sidebar configuration derived from environment variables.
 */
export function getSidebarConfig(): SidebarConfig {
  const hiddenTabs = parseHiddenSidebarTabs(process.env.APP_HIDDEN_SIDEBAR_TABS);
  return { hiddenTabs };
}

/**
 * Parses APP_HIDDEN_SIDEBAR_TABS into a stable tab id list.
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
