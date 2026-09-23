// pages/agent-panel/pages/agent-home-template-pills.tsx
// 首页 idle 阶段的模板卡片陈列：`AgentTemplate` 形状 + 图标与色系登记 + 列表渲染。
//
// §4.8 拆分（2026-09-23）：原先挤在 `AgentHomePage.tsx` 里——模板的**数据形状与视觉登记**
// （两者本文件自持）与页面的阶段状态、请求接线无关，页面只需要把取到的模板数组递进来、接住点击。
// 卡片本身不是独立交互单元（点击即回落成表单初值，由页面决定），因此这里只做陈列，不持有状态。
import { BookOpen, FileCode, FileText, Pencil, Search, Wand2 } from "lucide-react";
import type { CSSProperties } from "react";

/** Agent 模板 */
export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  skills: string[];
}

// 模板卡片图标色系
const TEMPLATE_COLORS = [
  { from: "#0891b2", to: "#22d3ee", shadow: "rgba(8,145,178,0.25)" },
  { from: "#0d9488", to: "#2dd4bf", shadow: "rgba(13,148,136,0.25)" },
  { from: "#d97706", to: "#fbbf24", shadow: "rgba(217,119,6,0.25)" },
  { from: "#2563eb", to: "#60a5fa", shadow: "rgba(37,99,235,0.25)" },
  { from: "#059669", to: "#34d399", shadow: "rgba(5,150,105,0.25)" },
  { from: "#0284c7", to: "#38bdf8", shadow: "rgba(2,132,199,0.25)" },
];

// 模板卡片图标列表
const TEMPLATE_ICONS = [Pencil, FileText, Search, FileCode, Wand2, BookOpen];

/** 模板卡片列表：色系与图标按序号轮转，模板数量超出登记长度时回到第一项。 */
export function AgentHomeTemplatePills({
  templates,
  onSelect,
}: {
  templates: AgentTemplate[];
  onSelect: (template: AgentTemplate) => void;
}) {
  return (
    <div className="agent-home-template-pills">
      {templates.map((template, index) => {
        const color = TEMPLATE_COLORS[index % TEMPLATE_COLORS.length];
        const Icon = TEMPLATE_ICONS[index % TEMPLATE_ICONS.length];

        return (
          <button
            key={template.id}
            type="button"
            onClick={() => onSelect(template)}
            className="agent-home-template-pill"
            style={
              {
                "--pill-accent": color.from,
                "--pill-accent-end": color.to,
                "--pill-glow": color.shadow,
              } as CSSProperties
            }
          >
            <span className="pill-icon">
              <Icon className="h-4 w-4" />
            </span>
            <span className="pill-copy">
              <span className="pill-title">{template.name}</span>
              <span className="pill-desc">{template.description}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
