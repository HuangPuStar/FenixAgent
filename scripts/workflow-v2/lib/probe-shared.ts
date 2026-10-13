/**
 * 探针套件共享的分组名与资源常量。
 *
 * 资源名固定，便于复用与人工辨认；改名等于放弃复用，会多留一个 App。
 */

/** 探针 App（organization ↔ 上游应用 的载体）名。 */
export const PROBE_APP_NAME = "fenix-contract-probe-app";
/** 探针 workflow 名；列表查询按它做精确匹配。 */
export const PROBE_WORKFLOW_NAME = "fenix-contract-probe-wf";
export const APP_ICON_URI = "default_icon/default_app_icon.png";
export const WORKFLOW_ICON_URI = "default_icon/default_workflow_icon.png";

export const GROUP_BOOTSTRAP = "bootstrap";
export const GROUP_WORKFLOW = "workflow";
export const GROUP_RUN = "run";
export const GROUP_VERSION = "version";
export const GROUP_PANEL = "node-panel";
export const GROUP_TRACE = "trace";
export const GROUP_AUTH = "auth";
export const GROUP_CLEANUP = "cleanup";
