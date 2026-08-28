import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Bot,
  Brain,
  CalendarClock,
  Cpu,
  Globe2,
  Home,
  KeyRound,
  LayoutTemplate,
  MessageSquareText,
  Plug,
  Settings2,
  Users,
  Workflow,
} from "lucide-react";

export type PageId =
  | "home"
  | "agents"
  | "chat"
  | "workflow"
  | "templates"
  | "models"
  | "skills"
  | "knowledge-bases"
  | "mcp"
  | "tasks"
  | "memories"
  | "sites"
  | "organizations"
  | "apikeys";

export interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "核心",
    items: [
      { id: "home", label: "首页", icon: Home },
      { id: "agents", label: "智能体管理", icon: Bot },
      { id: "chat", label: "Chat 设计", icon: MessageSquareText },
      { id: "workflow", label: "智能体编排", icon: Workflow },
      { id: "templates", label: "沙盒模版", icon: LayoutTemplate },
    ],
  },
  {
    label: "配置",
    items: [
      { id: "models", label: "模型库", icon: Cpu },
      { id: "skills", label: "技能库", icon: Settings2 },
      { id: "knowledge-bases", label: "知识库", icon: BookOpen },
      { id: "mcp", label: "插件市场", icon: Plug },
      { id: "tasks", label: "定时任务", icon: CalendarClock },
      { id: "memories", label: "记忆", icon: Brain },
      { id: "sites", label: "应用部署", icon: Globe2 },
      { id: "organizations", label: "组织", icon: Users },
      { id: "apikeys", label: "API Key", icon: KeyRound },
    ],
  },
];

export const PAGE_TITLES = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.id, item.label])),
) as Record<PageId, string>;
