/**
 * i18n 命名空间注册表 —— 跨包共享的 NS 常量与命名空间字面量联合类型。
 *
 * 只收录命名空间标识，**不**包含 i18next 单例：各语言 resources 的注册属宿主职责
 * （apps/web/src/i18n/index.ts 在本包 NS 的基础上叠加宿主自有命名空间）。
 * 拆出的原因是 packages 的 web 前端需要 NS 但不应依赖宿主 i18n 单例。
 */
export const NS = {
  COMMON: "common",
  LOGIN: "login",
  SIDEBAR: "sidebar",
  DASHBOARD: "dashboard",
  AGENTS: "agents",
  MODELS: "models",
  OBSERVER: "observer",
  SKILLS: "skills",
  MCP: "mcp",
  TASKS: "tasks",
  TASKS_V2: "tasksV2",
  WORKFLOWS: "workflows",
  SETTINGS: "settings",
  SESSIONS: "sessions",
  ENVIRONMENTS: "environments",
  ORGS: "orgs",
  APIKEY: "apikey",
  CHANNELS: "channels",
  KNOWLEDGE: "knowledge",
  AGENT_PANEL: "agentPanel",
  COMPONENTS: "components",
  HINDSIGHT: "hindsight",
  AGENT_HOME: "agentHome",
  PROD_VIEWS: "prodViews",
  TOOL_NARRATOR: "toolNarrator",
  /**
   * `@fenix/ui-components` 自有命名空间。
   *
   * 该包不自带 i18n 单例，组件统一通过 `useTranslation(UI_COMPONENTS_NS)` 取文案，
   * 文案真相来源是 `packages/ui-components/web/i18n/locales/<lng>/uiComponents.json`。
   * 宿主必须在渲染这些组件前把该 bundle 注册到同名命名空间，否则文案回退为 key。
   * 命名空间归属该包，故不在此处重复声明常量，只登记名称以保证宿主 `ns` 列表齐全。
   */
  UI_COMPONENTS: "uiComponents",
} as const;

export type Namespace = (typeof NS)[keyof typeof NS];
