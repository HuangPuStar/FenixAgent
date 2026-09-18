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
} as const;

export type Namespace = (typeof NS)[keyof typeof NS];
