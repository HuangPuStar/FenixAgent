import type { LucideIcon } from "lucide-react";
import { Cloud, Database, Files, GitBranch, Globe2, Search, TerminalSquare } from "lucide-react";
import type { OwnedMarketplaceScope } from "../../lib/resource-scope";

export interface MarketplaceMcpServer {
  id: string;
  name: string;
  publisher: string;
  description: string;
  category: "开发工具" | "数据" | "浏览器" | "云服务";
  transport: "stdio" | "HTTP";
  tools: number;
  installs: string;
  updatedAt: string;
  verified: boolean;
  icon: LucideIcon;
  accent: string;
  config: Record<string, unknown>;
  scope: OwnedMarketplaceScope;
}

export const MCP_MARKETPLACE_SERVERS: MarketplaceMcpServer[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    publisher: "modelcontextprotocol",
    description: "在授权的工作区范围内读取、搜索和修改文件与目录。",
    category: "开发工具",
    transport: "stdio",
    tools: 12,
    installs: "8.4k",
    updatedAt: "今天",
    verified: true,
    icon: Files,
    accent: "#2764e7",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    },
    scope: "市场",
  },
  {
    id: "browser-control",
    name: "Browser Control",
    publisher: "Fenix Labs",
    description: "让 Agent 检查页面结构、执行交互并验证本地 Web 应用。",
    category: "浏览器",
    transport: "HTTP",
    tools: 18,
    installs: "6.7k",
    updatedAt: "昨天",
    verified: true,
    icon: Globe2,
    accent: "#7256d8",
    config: {
      type: "http",
      url: "http://127.0.0.1:8931/mcp",
    },
    scope: "平台",
  },
  {
    id: "github",
    name: "GitHub",
    publisher: "GitHub",
    description: "读取仓库、Issue、Pull Request 与提交记录，并创建变更。",
    category: "开发工具",
    transport: "stdio",
    tools: 24,
    installs: "5.9k",
    updatedAt: "8 月 24 日",
    verified: true,
    icon: GitBranch,
    accent: "#252b36",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{env:RCS_SECRET_GITHUB}" },
    },
    scope: "个人",
  },
  {
    id: "postgresql",
    name: "PostgreSQL",
    publisher: "Fenix Data",
    description: "查询项目数据库结构与业务数据，默认以只读权限运行。",
    category: "数据",
    transport: "stdio",
    tools: 7,
    installs: "3.8k",
    updatedAt: "8 月 22 日",
    verified: true,
    icon: Database,
    accent: "#287aa9",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "{env:RCS_SECRET_DATABASE_URL}"],
    },
    scope: "本组织",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    publisher: "Cloudflare",
    description: "管理 Workers、站点、DNS 与部署状态，需要组织授权。",
    category: "云服务",
    transport: "HTTP",
    tools: 31,
    installs: "3.1k",
    updatedAt: "8 月 20 日",
    verified: true,
    icon: Cloud,
    accent: "#ee8b21",
    config: {
      type: "http",
      url: "https://mcp.cloudflare.local/sse",
      headers: { Authorization: "Bearer {env:RCS_SECRET_CLOUDFLARE}" },
    },
    scope: "本组织",
  },
  {
    id: "terminal",
    name: "Terminal",
    publisher: "Fenix Runtime",
    description: "在隔离环境执行命令并读取输出，遵循 Agent 权限策略。",
    category: "开发工具",
    transport: "stdio",
    tools: 5,
    installs: "2.6k",
    updatedAt: "8 月 18 日",
    verified: false,
    icon: TerminalSquare,
    accent: "#23906f",
    config: {
      command: "bunx",
      args: ["@fenix/mcp-terminal", "--sandbox"],
    },
    scope: "个人",
  },
  {
    id: "tavily-search",
    name: "Tavily Search",
    publisher: "Tavily",
    description: "为研究任务提供网页搜索与内容提取，并返回适合 Agent 使用的结构化结果。",
    category: "浏览器",
    transport: "HTTP",
    tools: 4,
    installs: "4.6k",
    updatedAt: "8 月 25 日",
    verified: true,
    icon: Search,
    accent: "#2f6edb",
    config: {
      type: "http",
      url: "https://mcp.tavily.local/sse",
      headers: { Authorization: "Bearer {env:RCS_SECRET_TAVILY}" },
    },
    scope: "市场",
  },
];

export function toMcpJson(server: MarketplaceMcpServer): string {
  return JSON.stringify({ mcpServers: { [server.id]: server.config } }, null, 2);
}
