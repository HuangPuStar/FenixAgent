import {
  Blocks,
  BookOpenText,
  CircleCheck,
  Database,
  FileCode2,
  Files,
  GitBranch,
  Globe2,
  type LucideIcon,
  Palette,
  Search,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

interface DemoPlugin {
  id: string;
  kind: "skill" | "mcp";
  name: string;
  description: string;
  icon: LucideIcon;
}

const SKILLS: readonly DemoPlugin[] = [
  {
    id: "frontend-design",
    kind: "skill",
    name: "Frontend Design",
    description: "设计并优化产品界面",
    icon: Palette,
  },
  { id: "research", kind: "skill", name: "Research", description: "检索资料并整理结论", icon: Search },
  {
    id: "documents",
    kind: "skill",
    name: "Documents",
    description: "创建和编辑文档",
    icon: BookOpenText,
  },
  {
    id: "code-review",
    kind: "skill",
    name: "Code Review",
    description: "检查代码规范与实现风险",
    icon: FileCode2,
  },
];

const MCP_PLUGINS: readonly DemoPlugin[] = [
  { id: "filesystem", kind: "mcp", name: "Filesystem", description: "读取工作区文件与目录", icon: Files },
  { id: "browser", kind: "mcp", name: "Browser", description: "查看和操作浏览器页面", icon: Globe2 },
  { id: "github", kind: "mcp", name: "GitHub", description: "读取仓库、Issue 与变更", icon: GitBranch },
  { id: "postgres", kind: "mcp", name: "PostgreSQL", description: "查询项目数据库", icon: Database },
];

const ALL_PLUGINS = [...SKILLS, ...MCP_PLUGINS];

export const DEFAULT_SELECTED_PLUGIN_IDS = ["frontend-design", "filesystem", "browser"] as const;

interface PluginTriggerProps {
  open: boolean;
  count: number;
  onToggle: () => void;
}

/** Opens the inline Plugin panel that shares the status-panel slot. */
export function PluginTrigger({ open, count, onToggle }: PluginTriggerProps) {
  return (
    <button
      type="button"
      className="chat-demo__plugin-trigger"
      data-open={open || undefined}
      aria-expanded={open}
      aria-controls="chat-demo-plugin-panel"
      onClick={onToggle}
    >
      <Blocks />
      <span>Plugin</span>
      {count > 0 && <small>{count}</small>}
    </button>
  );
}

interface PluginSelectionPanelProps {
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onClose: () => void;
}

/** Compact selection panel rendered in place of Todo while it is open. */
export function PluginSelectionPanel({ selectedIds, onToggle, onClose }: PluginSelectionPanelProps) {
  return (
    <section id="chat-demo-plugin-panel" className="chat-demo__plugin-panel" aria-label="Plugin 选择">
      <header className="chat-demo__plugin-header">
        <div>
          <strong>Plugin</strong>
          <span>为当前对话添加能力</span>
        </div>
        <div>
          <small>{selectedIds.size} 项已启用</small>
          <button type="button" aria-label="关闭 Plugin 面板" onClick={onClose}>
            <X />
          </button>
        </div>
      </header>

      <div className="chat-demo__plugin-panel-body">
        <PluginSection title="Skills" caption="当前对话的工作方式">
          {SKILLS.map((skill) => (
            <PluginOption key={skill.id} item={skill} selected={selectedIds.has(skill.id)} onToggle={onToggle} />
          ))}
        </PluginSection>

        <PluginSection title="MCP 插件" caption="Agent 可调用的连接">
          {MCP_PLUGINS.map((plugin) => (
            <PluginOption key={plugin.id} item={plugin} selected={selectedIds.has(plugin.id)} onToggle={onToggle} />
          ))}
        </PluginSection>
      </div>
    </section>
  );
}

interface SelectedPluginChipsProps {
  selectedIds: ReadonlySet<string>;
  onRemove: (id: string) => void;
}

/** Turn-scoped Plugin markers shown before the prompt input. */
export function SelectedPluginChips({ selectedIds, onRemove }: SelectedPluginChipsProps) {
  const selected = ALL_PLUGINS.filter((plugin) => selectedIds.has(plugin.id));
  if (selected.length === 0) return null;

  return (
    <fieldset className="chat-demo__composer-plugins" aria-label="已选择的 Plugin">
      {selected.map((plugin) => {
        const Icon = plugin.icon;
        return (
          <button key={plugin.id} type="button" aria-label={`移除 ${plugin.name}`} onClick={() => onRemove(plugin.id)}>
            <Icon className="chat-demo__composer-plugin-icon" />
            <span>{plugin.name}</span>
            <X className="chat-demo__composer-plugin-remove" />
          </button>
        );
      })}
    </fieldset>
  );
}

function PluginOption({
  item,
  selected,
  onToggle,
}: {
  item: DemoPlugin;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      className={selected ? "is-selected" : undefined}
      aria-pressed={selected}
      onClick={() => onToggle(item.id)}
    >
      <Icon />
      <span>
        <strong>{item.name}</strong>
        <small>{item.description}</small>
      </span>
      {item.kind === "skill" ? (
        selected && <CircleCheck className="chat-demo__plugin-check" />
      ) : (
        <em>{selected ? "已连接" : "未连接"}</em>
      )}
    </button>
  );
}

function PluginSection({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
  return (
    <section className="chat-demo__plugin-section" aria-label={title}>
      <div className="chat-demo__plugin-section-title">
        <strong>{title}</strong>
        <span>{caption}</span>
      </div>
      <div className="chat-demo__plugin-list">{children}</div>
    </section>
  );
}
