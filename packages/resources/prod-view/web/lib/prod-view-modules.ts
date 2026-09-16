import type { ProdViewModulesConfig } from "@/src/api/prod-views";

/** Chat 主体模块 */
export const CHAT_MODULE_KEYS = [
  "chatHeader",
  "sessionSidebar",
  "chatView",
  "chatComposer",
  "permissionPanel",
  "todoPanel",
  "contextPanel",
  "toolCallRow",
] as const;

/** 右侧附加面板模块 */
export const PANEL_MODULE_KEYS = ["filesPanel", "sitesPanel", "tasksPanel", "viewsPanel"] as const;

export const ALL_MODULE_KEYS = [...CHAT_MODULE_KEYS, ...PANEL_MODULE_KEYS] as const;

/** 默认：Chat 模块始终启用，附加面板默认关闭 */
export function defaultEnabledMap(): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const key of CHAT_MODULE_KEYS) {
    map[key] = true;
  }
  for (const key of PANEL_MODULE_KEYS) {
    map[key] = false;
  }
  return map;
}

/** 从 ProdView 的 modulesConfig 还原为 edit dialog 的 enabled 状态 */
export function buildEnabledMap(cfg: ProdViewModulesConfig): Record<string, boolean> {
  const map = defaultEnabledMap();
  for (const key of ALL_MODULE_KEYS) {
    const m = cfg[key];
    if (m !== undefined) map[key] = m.enabled !== false;
  }
  return map;
}

/** 合并编辑中的 enabled 状态和已有 modulesConfig，产出最终配置 */
export function buildModulesConfig(
  editingModulesConfig: ProdViewModulesConfig | undefined | null,
  formModules: Record<string, boolean>,
): ProdViewModulesConfig {
  const cfg: ProdViewModulesConfig = {};
  for (const key of ALL_MODULE_KEYS) {
    cfg[key] = { ...editingModulesConfig?.[key], enabled: formModules[key] };
  }
  return cfg;
}
