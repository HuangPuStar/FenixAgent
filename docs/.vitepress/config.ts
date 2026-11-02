import { defineConfig } from "vitepress";

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
          text: "系统开发",
          items: [
            { text: "后端开发规范", link: "/developer/system/backend-development" },
            { text: "前端开发规范", link: "/developer/system/frontend-development" },
            { text: "代码行为门禁", link: "/developer/system/forbidden-code-patterns" },
            { text: "ACP 会话重命名", link: "/developer/system/acp-session-rename" },
            { text: "External API", link: "/developer/system/external-api" },
            { text: "Agent 管理与会话说明", link: "/developer/system/external-agent-session-guide" },
          ],
        },
        {
          text: "Agent 开发",
          items: [
            { text: "系统提示词", link: "/developer/agent/system-prompt" },
            { text: "Skill 开发", link: "/developer/agent/skill-development" },
            { text: "多智能体协作", link: "/developer/agent/multi-agent" },
            { text: "MCP 工具集成", link: "/developer/agent/mcp-integration" },
            { text: "知识库", link: "/developer/agent/knowledge-base" },
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
        {
          text: "系统架构开发",
          items: [
            { text: "索引", link: "/developer/architecture/" },
            { text: "工程架构与开发规范", link: "/developer/architecture/engineering-standards" },
            { text: "目录结构与归属", link: "/developer/architecture/directory-structure" },
            { text: "Access Control 开发指引", link: "/developer/architecture/access-control" },
            { text: "边界豁免与依赖残留", link: "/developer/architecture/boundary-exemptions" },
            { text: "工程债务与优化项", link: "/developer/architecture/engineering-debt" },
            { text: "EE 扩展架构", link: "/developer/architecture/ee-extension-architecture" },
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
            { text: "Docker 部署架构与拓扑", link: "/arch/26-deployment-topology" },
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
            { text: "Agent 输出可视化（四条路径定位）", link: "/arch/27-agent-output-visualization" },
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
            { text: "标准观测", link: "/arch/observability" },
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
            { text: "公共 Git", link: "/arch/28-common-git" },
            { text: "工单", link: "/arch/29-tickets" },
          ],
        },
        { text: "Access Control", link: "/arch/29-access-control" },
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
            { text: "Docker 编排体系", link: "/operations/docker-topology" },
            { text: "标准观测", link: "/operations/observability" },
            { text: "Workflow V2 部署", link: "/operations/workflow-deployment" },
            { text: "公共 Git（Forgejo）", link: "/operations/common-git" },
            { text: "工单（Tickets）", link: "/operations/tickets" },
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
