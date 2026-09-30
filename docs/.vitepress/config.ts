import { defineConfig } from "vitepress";

/**
 * ADR（`docs/adr/`）的侧栏分组。
 *
 * 侧栏是手工清单而不是按目录收集，所以落在 `docs/` 树内的 ADR 默认没有入口；而两篇 ADR 原先在
 * `spec/global/adr/`（`spec/` 不在 `docs/` 这棵站点源里），落点 2026-09-24 统一到 `docs/adr/` 后
 * 它们开始随站点构建，必须补上入口，否则既进不了导航、打开的页面也没有侧栏。同一条目挂两处：
 * 读者从 `/arch/` 进来（架构文档里的 ADR 引用都在这一支），打开 ADR 页时自身也有导航。
 */
const ADR_SIDEBAR_GROUP = {
  text: "架构决策（ADR）",
  items: [
    { text: "编排域独立包设计", link: "/adr/2026-08-03-orchestration-package-design" },
    { text: "Chat 域独立包设计（chat-channel）", link: "/adr/2026-08-04-chat-channel-package-design" },
    { text: "知识库 /api 列表合同变更", link: "/adr/2026-09-24-knowledge-bases-api-list-contract" },
    { text: "Agent Sites 发布面可见性解释权", link: "/adr/2026-09-25-agent-sites-publish-face-visibility" },
  ],
};

export default defineConfig({
  base: "/FenixAgent/",
  title: "FenixAgent",
  description: "Fenix Agent — AI Agent 智能控制平台",
  lang: "zh-CN",
  // 全局强制亮色：`appearance: false` 让 VitePress 既不渲染导航栏的外观开关，
  // 也不注入 useDark（它读 localStorage + matchMedia 决定是否挂 .dark 类），
  // useData().isDark 因此恒为 false —— Mermaid 等下游主题分支随之固定走亮色。
  appearance: false,
  markdown: {
    theme: {
      light: "github-light",
      dark: "github-light",
    },
  },
  head: [
    ["link", { rel: "icon", type: "image/png", href: "/FenixAgent/fenix-agent-logo-mark.png" }],
    ["link", { rel: "apple-touch-icon", href: "/FenixAgent/fenix-agent-logo-mark.png" }],
    ["meta", { name: "theme-color", content: "#1677ff" }],
    ["meta", { name: "og:type", content: "website" }],
    ["meta", { name: "og:locale", content: "zh_CN" }],
  ],
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  themeConfig: {
    logo: "/fenix-agent-logo-mark.png",
    siteTitle: "FenixAgent",
    nav: [
      { text: "用户文档", link: "/user/" },
      { text: "开发者文档", link: "/developer/" },
      { text: "架构文档", link: "/arch/" },
      { text: "运维文档", link: "/operations/" },
    ],
    sidebar: {
      "/user/": [
        {
          text: "首页",
          items: [{ text: "产品介绍", link: "/user/" }],
        },
        {
          text: "配置",
          items: [
            { text: "大模型配置", link: "/user/models/" },
            { text: "Agent 管理", link: "/user/agents/" },
          ],
        },
        {
          text: "功能",
          items: [
            { text: "定时任务", link: "/user/scheduled-tasks/" },
            { text: "Skills", link: "/user/skills/" },
            { text: "MCP", link: "/user/mcp/" },
            { text: "知识库", link: "/user/knowledge-base/" },
            { text: "智能体编排", link: "/user/workflow/" },
          ],
        },
        {
          text: "帮助",
          items: [{ text: "故障排查", link: "/user/troubleshooting/" }],
        },
      ],
      "/developer/": [
        {
          text: "首页",
          items: [{ text: "开发者指南", link: "/developer/" }],
        },
        {
          text: "使用指南",
          items: [
            { text: "后端开发规范", link: "/developer/guide/backend-development" },
            { text: "External API", link: "/developer/guide/external-api" },
            { text: "Agent 管理与会话说明", link: "/developer/guide/external-agent-session-guide" },
            { text: "系统提示词", link: "/developer/guide/system-prompt" },
            { text: "Skill 开发", link: "/developer/guide/skill-development" },
            { text: "多智能体协作", link: "/developer/guide/multi-agent" },
            { text: "MCP 工具集成", link: "/developer/guide/mcp-integration" },
            { text: "知识库", link: "/developer/guide/knowledge-base" },
          ],
        },
        {
          text: "架构参考",
          items: [
            { text: "Agent 引擎架构", link: "/developer/arch/agent-engine-architecture" },
            { text: "Agent Sites 架构", link: "/developer/arch/agent-sites-architecture" },
            { text: "Workflow 架构", link: "/developer/arch/workflow-architecture" },
            { text: "Remote Machine Registry", link: "/developer/arch/remote-machine-registry" },
          ],
        },
      ],
      "/arch/": [
        {
          text: "全局概览",
          items: [
            { text: "总体架构", link: "/arch/tech-stack-overview" },
            { text: "后端技术栈", link: "/arch/tech-stack-backend" },
            { text: "前端技术栈", link: "/arch/tech-stack-frontend" },
            { text: "领域术语表", link: "/arch/domain-glossary" },
          ],
        },
        {
          text: "权限与认证",
          items: [
            { text: "认证系统", link: "/arch/03-auth" },
            { text: "用户与组织", link: "/arch/14-user-org" },
          ],
        },
        {
          text: "Agent 系统",
          items: [
            { text: "Agent Config", link: "/arch/04-agent-config" },
            { text: "AgentController", link: "/arch/20-orchestration-management" },
            { text: "Chat 前端界面", link: "/arch/05-chat" },
            { text: "YJS 流式链路", link: "/arch/19-yjs-chat-streaming" },
            { text: "文件系统", link: "/arch/12-files" },
          ],
        },
        {
          text: "配置系统",
          items: [
            { text: "概览", link: "/arch/06-config" },
            { text: "模型配置", link: "/arch/06-config-provider" },
            { text: "Skills 配置", link: "/arch/06-config-skills" },
            { text: "MCP 配置", link: "/arch/06-config-mcp" },
            { text: "记忆配置", link: "/arch/06-config-hindsight" },
          ],
        },
        {
          text: "可观测性",
          items: [
            { text: "Observer Service", link: "/arch/21-observability-observer-service" },
          ],
        },
        {
          text: "业务模块",
          items: [
            { text: "工作流引擎", link: "/arch/17-workflow" },
            { text: "知识库", link: "/arch/11-knowledge" },
            { text: "Agent Sites", link: "/arch/18-agent-sites" },
            { text: "插件市场", link: "/arch/24-plugin-market" },
          ],
        },
        {
          text: "附录",
          items: [
            { text: "改动清单", link: "/arch/changes" },
          ],
        },
        ADR_SIDEBAR_GROUP,
      ],
      "/adr/": [ADR_SIDEBAR_GROUP],
      // CE/EE 重构文档集（`docs/design/ce-ee-refactoring/`）同样落在手工清单之外，理由同上：
      // 侧栏不按目录收集，整目录必须在这里登记，否则页面既进不了导航、打开后也没有侧栏。
      // 其中「边界豁免与依赖残留登记」是规范 §10.7 完成证据第 4 条的登记处，必须可被找到。
      "/design/": [
        {
          text: "CE/EE 重构",
          items: [
            { text: "架构设计索引", link: "/design/ce-ee-refactoring/ce-ee-engineering-architecture" },
            { text: "目标架构与开发规范", link: "/design/ce-ee-refactoring/ce-ee-engineering-standards" },
            { text: "目录结构与归属", link: "/design/ce-ee-refactoring/ce-ee-engineering-directory-structure" },
            { text: "待整改项", link: "/design/ce-ee-refactoring/ce-standards-todo" },
            { text: "边界豁免与依赖残留登记", link: "/design/ce-ee-refactoring/boundary-exemptions" },
            { text: "CE 权限模型设计", link: "/design/ce-ee-refactoring/ce-access-control-design" },
            { text: "EE 扩展架构", link: "/design/ce-ee-refactoring/ee-extension-architecture" },
          ],
        },
      ],
      // 运维文档（`docs/operations/`）同样落在手工清单之外：侧栏不按目录收集，新增目录必须在
      // 这里登记，否则页面既进不了导航、打开后也没有侧栏。分组按目录职责（部署、升级、迁移、
      // 备份、排障）与文件一一对应。
      "/operations/": [
        {
          text: "运维",
          items: [
            { text: "总览", link: "/operations/" },
            { text: "部署", link: "/operations/deployment" },
            { text: "升级", link: "/operations/upgrade" },
            { text: "迁移", link: "/operations/migration" },
            { text: "备份与恢复", link: "/operations/backup-and-restore" },
            { text: "排障", link: "/operations/troubleshooting" },
          ],
        },
      ],
    },
    socialLinks: [{ icon: "github", link: "https://github.com/konghayao/remote-control-server" }],
    search: {
      provider: "local",
      options: {
        translations: {
          button: {
            buttonText: "搜索",
            buttonAriaLabel: "搜索文档",
          },
          modal: {
            noResultsText: "无法找到相关结果",
            resetButtonTitle: "清除查询",
            footer: {
              selectText: "选择",
              navigateText: "切换",
              closeText: "关闭",
            },
          },
        },
      },
    },
    editLink: {
      pattern: "https://github.com/konghayao/remote-control-server/edit/main/docs/:path",
      text: "在 GitHub 上编辑此页",
    },
    outline: {
      level: [2, 3],
      label: "本页目录",
    },
    docFooter: {
      prev: "上一篇",
      next: "下一篇",
    },
    returnToTopLabel: "回到顶部",
    sidebarMenuLabel: "菜单",
  },
});
