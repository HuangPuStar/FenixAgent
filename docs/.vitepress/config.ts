import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/FenixAgent/",
  title: "FenixAgent",
  description: "Fenix Agent 控制面板 — AI Agent 任务控制中心",
  lang: "zh-CN",
  markdown: {
    theme: {
      light: "github-light",
      dark: "github-light",
    },
  },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/FenixAgent/logo.svg" }],
    ["meta", { name: "theme-color", content: "#1677ff" }],
    ["meta", { name: "og:type", content: "website" }],
    ["meta", { name: "og:locale", content: "zh_CN" }],
  ],
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  themeConfig: {
    logo: "/FenixAgent/logo.svg",
    siteTitle: "FenixAgent",
    nav: [
      { text: "用户文档", link: "/user/" },
      { text: "开发者文档", link: "/developer/" },
      { text: "架构文档", link: "/arch/" },
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
      ],
      "/arch/": [
        {
          text: "全局概览",
          items: [
            { text: "总体架构", link: "/arch/tech-stack-overview" },
            { text: "后端技术栈", link: "/arch/tech-stack-backend" },
            { text: "前端技术栈", link: "/arch/tech-stack-frontend" },
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
            { text: "Agent 实例", link: "/arch/08-instance" },
            { text: "Agent 接口", link: "/arch/05-chat" },
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
          text: "业务模块",
          items: [
            { text: "工作流引擎", link: "/arch/17-workflow" },
            { text: "知识库", link: "/arch/11-knowledge" },
            { text: "Agent Sites", link: "/arch/18-agent-sites" },
          ],
        },
        {
          text: "附录",
          items: [
            { text: "改动清单", link: "/arch/changes" },
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
    darkModeSwitchLabel: "主题",
    lightModeSwitchTitle: "切换到亮色主题",
    darkModeSwitchTitle: "切换到暗色主题",
  },
});
