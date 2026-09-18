import { NS } from "@fenix/web-runtime/i18n/namespace";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next/initReactI18next";
import channelsEN from "../../../../packages/resources/channel/web/i18n/en/channels.json";
import channelsZH from "../../../../packages/resources/channel/web/i18n/zh/channels.json";
import apikeyEN from "../../../../packages/resources/identity-admin/web/i18n/en/apikey.json";
import orgsEN from "../../../../packages/resources/identity-admin/web/i18n/en/orgs.json";
import apikeyZH from "../../../../packages/resources/identity-admin/web/i18n/zh/apikey.json";
import orgsZH from "../../../../packages/resources/identity-admin/web/i18n/zh/orgs.json";
import knowledgeEN from "../../../../packages/resources/knowledge/web/i18n/locales/en/knowledge.json";
import knowledgeZH from "../../../../packages/resources/knowledge/web/i18n/locales/zh/knowledge.json";
import mcpEN from "../../../../packages/resources/mcp/web/i18n/locales/en/mcp.json";
import mcpZH from "../../../../packages/resources/mcp/web/i18n/locales/zh/mcp.json";
import hindsightEN from "../../../../packages/resources/memory/web/i18n/locales/en/hindsight.json";
import hindsightZH from "../../../../packages/resources/memory/web/i18n/locales/zh/hindsight.json";
import observerEN from "../../../../packages/resources/observer/web/i18n/en/observer.json";
import observerZH from "../../../../packages/resources/observer/web/i18n/zh/observer.json";
import prodViewsEN from "../../../../packages/resources/prod-view/web/i18n/en/prodViews.json";
import prodViewsZH from "../../../../packages/resources/prod-view/web/i18n/zh/prodViews.json";
import skillsEN from "../../../../packages/resources/skill/web/i18n/locales/en/skills.json";
import skillsZH from "../../../../packages/resources/skill/web/i18n/locales/zh/skills.json";
import tasksV2EN from "../../../../packages/resources/task/web/i18n/en/tasks-v2.json";
import tasksV2ZH from "../../../../packages/resources/task/web/i18n/zh/tasks-v2.json";
import workflowsEN from "../../../../packages/resources/workflow/web/i18n/en/workflows.json";
import workflowsZH from "../../../../packages/resources/workflow/web/i18n/zh/workflows.json";
import uiComponentsEN from "../../../../packages/ui-components/web/i18n/locales/en/uiComponents.json";
import uiComponentsZH from "../../../../packages/ui-components/web/i18n/locales/zh/uiComponents.json";
import agentHomeEN from "./locales/en/agentHome.json";
import agentPanelEN from "./locales/en/agentPanel.json";
import agentsEN from "./locales/en/agents.json";
import commonEN from "./locales/en/common.json";
import componentsEN from "./locales/en/components.json";
import dashboardEN from "./locales/en/dashboard.json";
import environmentsEN from "./locales/en/environments.json";
import loginEN from "./locales/en/login.json";
import modelsEN from "./locales/en/models.json";
import sessionsEN from "./locales/en/sessions.json";
import settingsEN from "./locales/en/settings.json";
import sidebarEN from "./locales/en/sidebar.json";
import tasksEN from "./locales/en/tasks.json";
import toolNarratorEN from "./locales/en/toolNarrator.json";
import agentHomeZH from "./locales/zh/agentHome.json";
import agentPanelZH from "./locales/zh/agentPanel.json";
import agentsZH from "./locales/zh/agents.json";
import commonZH from "./locales/zh/common.json";
import componentsZH from "./locales/zh/components.json";
import dashboardZH from "./locales/zh/dashboard.json";
import environmentsZH from "./locales/zh/environments.json";
import loginZH from "./locales/zh/login.json";
import modelsZH from "./locales/zh/models.json";
import sessionsZH from "./locales/zh/sessions.json";
import settingsZH from "./locales/zh/settings.json";
import sidebarZH from "./locales/zh/sidebar.json";
import tasksZH from "./locales/zh/tasks.json";
import toolNarratorZH from "./locales/zh/toolNarrator.json";

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
        // `@fenix/ui-components` 的组件文案（packages 的 web 前端已切到该包）
        [NS.UI_COMPONENTS]: uiComponentsEN,
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
        [NS.UI_COMPONENTS]: uiComponentsZH,
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
      NS.UI_COMPONENTS,
    ],
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "rcs-lang",
      caches: ["localStorage"],
    },
  });

export default i18n;
