import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next/initReactI18next";
import agentHomeEN from "../../../../web/src/i18n/locales/en/agentHome.json";
import agentPanelEN from "../../../../web/src/i18n/locales/en/agentPanel.json";
import agentsEN from "../../../../web/src/i18n/locales/en/agents.json";
import apikeyEN from "../../../../web/src/i18n/locales/en/apikey.json";
import channelsEN from "../../../../web/src/i18n/locales/en/channels.json";
import commonEN from "../../../../web/src/i18n/locales/en/common.json";
import componentsEN from "../../../../web/src/i18n/locales/en/components.json";
import dashboardEN from "../../../../web/src/i18n/locales/en/dashboard.json";
import environmentsEN from "../../../../web/src/i18n/locales/en/environments.json";
import hindsightEN from "../../../../web/src/i18n/locales/en/hindsight.json";
import knowledgeEN from "../../../../web/src/i18n/locales/en/knowledge.json";
import loginEN from "../../../../web/src/i18n/locales/en/login.json";
import mcpEN from "../../../../web/src/i18n/locales/en/mcp.json";
import modelsEN from "../../../../web/src/i18n/locales/en/models.json";
import observerEN from "../../../../web/src/i18n/locales/en/observer.json";
import orgsEN from "../../../../web/src/i18n/locales/en/orgs.json";
import prodViewsEN from "../../../../web/src/i18n/locales/en/prodViews.json";
import sessionsEN from "../../../../web/src/i18n/locales/en/sessions.json";
import settingsEN from "../../../../web/src/i18n/locales/en/settings.json";
import sidebarEN from "../../../../web/src/i18n/locales/en/sidebar.json";
import skillsEN from "../../../../web/src/i18n/locales/en/skills.json";
import tasksEN from "../../../../web/src/i18n/locales/en/tasks.json";
import tasksV2EN from "../../../../web/src/i18n/locales/en/tasks-v2.json";
import toolNarratorEN from "../../../../web/src/i18n/locales/en/toolNarrator.json";
import workflowsEN from "../../../../web/src/i18n/locales/en/workflows.json";
import agentHomeZH from "../../../../web/src/i18n/locales/zh/agentHome.json";
import agentPanelZH from "../../../../web/src/i18n/locales/zh/agentPanel.json";
import agentsZH from "../../../../web/src/i18n/locales/zh/agents.json";
import apikeyZH from "../../../../web/src/i18n/locales/zh/apikey.json";
import channelsZH from "../../../../web/src/i18n/locales/zh/channels.json";
import commonZH from "../../../../web/src/i18n/locales/zh/common.json";
import componentsZH from "../../../../web/src/i18n/locales/zh/components.json";
import dashboardZH from "../../../../web/src/i18n/locales/zh/dashboard.json";
import environmentsZH from "../../../../web/src/i18n/locales/zh/environments.json";
import hindsightZH from "../../../../web/src/i18n/locales/zh/hindsight.json";
import knowledgeZH from "../../../../web/src/i18n/locales/zh/knowledge.json";
import loginZH from "../../../../web/src/i18n/locales/zh/login.json";
import mcpZH from "../../../../web/src/i18n/locales/zh/mcp.json";
import modelsZH from "../../../../web/src/i18n/locales/zh/models.json";
import observerZH from "../../../../web/src/i18n/locales/zh/observer.json";
import orgsZH from "../../../../web/src/i18n/locales/zh/orgs.json";
import prodViewsZH from "../../../../web/src/i18n/locales/zh/prodViews.json";
import sessionsZH from "../../../../web/src/i18n/locales/zh/sessions.json";
import settingsZH from "../../../../web/src/i18n/locales/zh/settings.json";
import sidebarZH from "../../../../web/src/i18n/locales/zh/sidebar.json";
import skillsZH from "../../../../web/src/i18n/locales/zh/skills.json";
import tasksZH from "../../../../web/src/i18n/locales/zh/tasks.json";
import tasksV2ZH from "../../../../web/src/i18n/locales/zh/tasks-v2.json";
import toolNarratorZH from "../../../../web/src/i18n/locales/zh/toolNarrator.json";
import workflowsZH from "../../../../web/src/i18n/locales/zh/workflows.json";

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

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        [NS.COMMON]: commonEN,
        [NS.LOGIN]: loginEN,
        [NS.SIDEBAR]: sidebarEN,
        [NS.DASHBOARD]: dashboardEN,
        [NS.TASKS]: tasksEN,
        [NS.TASKS_V2]: tasksV2EN,
        [NS.AGENTS]: agentsEN,
        [NS.MODELS]: modelsEN,
        [NS.OBSERVER]: observerEN,
        [NS.ENVIRONMENTS]: environmentsEN,
        [NS.SKILLS]: skillsEN,
        [NS.MCP]: mcpEN,
        [NS.AGENT_PANEL]: agentPanelEN,
        [NS.SESSIONS]: sessionsEN,
        [NS.ORGS]: orgsEN,
        [NS.APIKEY]: apikeyEN,
        [NS.CHANNELS]: channelsEN,
        [NS.KNOWLEDGE]: knowledgeEN,
        [NS.COMPONENTS]: componentsEN,
        [NS.WORKFLOWS]: workflowsEN,
        [NS.SETTINGS]: settingsEN,
        [NS.HINDSIGHT]: hindsightEN,
        [NS.AGENT_HOME]: agentHomeEN,
        [NS.PROD_VIEWS]: prodViewsEN,
        [NS.TOOL_NARRATOR]: toolNarratorEN,
      },
      zh: {
        [NS.COMMON]: commonZH,
        [NS.LOGIN]: loginZH,
        [NS.SIDEBAR]: sidebarZH,
        [NS.DASHBOARD]: dashboardZH,
        [NS.TASKS]: tasksZH,
        [NS.TASKS_V2]: tasksV2ZH,
        [NS.AGENTS]: agentsZH,
        [NS.MODELS]: modelsZH,
        [NS.OBSERVER]: observerZH,
        [NS.ENVIRONMENTS]: environmentsZH,
        [NS.SKILLS]: skillsZH,
        [NS.MCP]: mcpZH,
        [NS.AGENT_PANEL]: agentPanelZH,
        [NS.SESSIONS]: sessionsZH,
        [NS.ORGS]: orgsZH,
        [NS.APIKEY]: apikeyZH,
        [NS.CHANNELS]: channelsZH,
        [NS.KNOWLEDGE]: knowledgeZH,
        [NS.COMPONENTS]: componentsZH,
        [NS.WORKFLOWS]: workflowsZH,
        [NS.SETTINGS]: settingsZH,
        [NS.HINDSIGHT]: hindsightZH,
        [NS.AGENT_HOME]: agentHomeZH,
        [NS.PROD_VIEWS]: prodViewsZH,
        [NS.TOOL_NARRATOR]: toolNarratorZH,
      },
    },
    fallbackLng: "en",
    defaultNS: NS.COMMON,
    ns: [
      NS.COMMON,
      NS.LOGIN,
      NS.SIDEBAR,
      NS.DASHBOARD,
      NS.TASKS,
      NS.TASKS_V2,
      NS.ENVIRONMENTS,
      NS.OBSERVER,
      NS.SKILLS,
      NS.MCP,
      NS.AGENT_PANEL,
      NS.SESSIONS,
      NS.ORGS,
      NS.APIKEY,
      NS.CHANNELS,
      NS.KNOWLEDGE,
      NS.COMPONENTS,
      NS.WORKFLOWS,
      NS.SETTINGS,
      NS.HINDSIGHT,
      NS.AGENT_HOME,
      NS.PROD_VIEWS,
      NS.TOOL_NARRATOR,
    ],
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "rcs-lang",
      caches: ["localStorage"],
    },
  });

export default i18n;
