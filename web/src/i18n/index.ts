import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next/initReactI18next";
import agentHomeEN from "./locales/en/agentHome.json";
import agentPanelEN from "./locales/en/agentPanel.json";
import agentsEN from "./locales/en/agents.json";
import apikeyEN from "./locales/en/apikey.json";
import channelsEN from "./locales/en/channels.json";
import commonEN from "./locales/en/common.json";
import componentsEN from "./locales/en/components.json";
import dashboardEN from "./locales/en/dashboard.json";
import environmentsEN from "./locales/en/environments.json";
import faqEN from "./locales/en/faq.json";
import hindsightEN from "./locales/en/hindsight.json";
import knowledgeEN from "./locales/en/knowledge.json";
import loginEN from "./locales/en/login.json";
import mcpEN from "./locales/en/mcp.json";
import modelsEN from "./locales/en/models.json";
import orgsEN from "./locales/en/orgs.json";
import prodViewsEN from "./locales/en/prodViews.json";
import sessionsEN from "./locales/en/sessions.json";
import settingsEN from "./locales/en/settings.json";
import sidebarEN from "./locales/en/sidebar.json";
import skillsEN from "./locales/en/skills.json";
import tasksEN from "./locales/en/tasks.json";
import tasksV2EN from "./locales/en/tasks-v2.json";
import toolNarratorEN from "./locales/en/toolNarrator.json";
import workflowsEN from "./locales/en/workflows.json";
import agentHomeZH from "./locales/zh/agentHome.json";
import agentPanelZH from "./locales/zh/agentPanel.json";
import agentsZH from "./locales/zh/agents.json";
import apikeyZH from "./locales/zh/apikey.json";
import channelsZH from "./locales/zh/channels.json";
import commonZH from "./locales/zh/common.json";
import componentsZH from "./locales/zh/components.json";
import dashboardZH from "./locales/zh/dashboard.json";
import environmentsZH from "./locales/zh/environments.json";
import faqZH from "./locales/zh/faq.json";
import hindsightZH from "./locales/zh/hindsight.json";
import knowledgeZH from "./locales/zh/knowledge.json";
import loginZH from "./locales/zh/login.json";
import mcpZH from "./locales/zh/mcp.json";
import modelsZH from "./locales/zh/models.json";
import orgsZH from "./locales/zh/orgs.json";
import prodViewsZH from "./locales/zh/prodViews.json";
import sessionsZH from "./locales/zh/sessions.json";
import settingsZH from "./locales/zh/settings.json";
import sidebarZH from "./locales/zh/sidebar.json";
import skillsZH from "./locales/zh/skills.json";
import tasksZH from "./locales/zh/tasks.json";
import tasksV2ZH from "./locales/zh/tasks-v2.json";
import toolNarratorZH from "./locales/zh/toolNarrator.json";
import workflowsZH from "./locales/zh/workflows.json";

export const NS = {
  COMMON: "common",
  LOGIN: "login",
  SIDEBAR: "sidebar",
  DASHBOARD: "dashboard",
  AGENTS: "agents",
  MODELS: "models",
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
  FAQ: "faq",
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
        [NS.ENVIRONMENTS]: environmentsEN,
        [NS.FAQ]: faqEN,
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
        [NS.ENVIRONMENTS]: environmentsZH,
        [NS.FAQ]: faqZH,
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
