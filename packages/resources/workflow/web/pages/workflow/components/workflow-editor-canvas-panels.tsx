import { Panel } from "@xyflow/react";
import {
  Bot,
  Boxes,
  CheckCircle,
  Code,
  FilePlus,
  Flag,
  Globe,
  LayoutGrid,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CustomToolItem } from "../../../api/workflow-defs";
import { TRANSFORM_PRESETS } from "../presets";

/**
 * 画布内的两块浮层（§4.8 的「渲染装配」与「画布数据」分开）：
 * 左上角的节点面板（palette）与顶部的工具栏。
 *
 * 两者都只把「画布上能拖什么 / 能点哪些动作」翻译成按钮，动作实现全部由编辑器注入；
 * 节点面板里的 custom 分区与变换预设依赖 `customTools` 与 `TRANSFORM_PRESETS`，
 * 工具栏只依赖保存状态与运行态。
 */

const BASIC_PALETTE_ITEMS = [
  { type: "shell", labelKey: "nodes.shell", icon: Terminal, color: "#3b82f6" },
  { type: "python", labelKey: "nodes.python", icon: Code, color: "#0ea5e9" },
  { type: "agent", labelKey: "nodes.agent", icon: Bot, color: "#22c55e" },
  { type: "api", labelKey: "nodes.api", icon: Globe, color: "#8b5cf6" },
  { type: "audit", labelKey: "editor.palette_audit", icon: ShieldCheck, color: "#f59e0b" },
  { type: "end", labelKey: "nodes.end", icon: Flag, color: "#22c55e" },
] as const;

export interface NodePalettePanelProps {
  customTools: CustomToolItem[];
  addNode: (
    type: string,
    presetOrPosition?: string | { x: number; y: number },
    positionFallback?: { x: number; y: number },
    tool?: string,
    outputs?: Record<string, { pattern: string; type: string }>,
  ) => void;
}

export function NodePalettePanel({ customTools, addNode }: NodePalettePanelProps) {
  const { t } = useTranslation("workflows");

  return (
    <Panel position="top-left" className="wf-panel-palette">
      <div className="wf-palette">
        <div className="wf-palette-title">{t("editor.palette_drag_hint")}</div>
        {/* 基础节点 */}
        {BASIC_PALETTE_ITEMS.map((item) => (
          <button
            key={item.type}
            type="button"
            className="wf-palette-btn"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/workflow-node", item.type);
              e.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => addNode(item.type)}
          >
            <span className="wf-palette-icon" style={{ background: item.color }}>
              <item.icon size={14} />
            </span>
            {t(item.labelKey)}
          </button>
        ))}
        {/* 分隔线 */}
        <div className="wf-palette-divider" />
        {/* 自定义工具（仅当 registry 非空时显示） */}
        {customTools.length > 0 && (
          <>
            <div className="wf-palette-group-title">{t("editor.palette_custom_tools")}</div>
            {customTools.map((tool) => (
              <button
                key={tool.name}
                type="button"
                className="wf-palette-btn"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/workflow-node", "custom");
                  e.dataTransfer.setData("application/workflow-tool", tool.name);
                  // 预填默认 outputs，避免 YAML 序列化时缺失 outputs 字段
                  // 通配符工具（如 slurm）也预填 stdout 作为兜底默认输出
                  e.dataTransfer.setData(
                    "application/workflow-outputs",
                    JSON.stringify(
                      tool.produces.includes("*") || tool.produces.length === 0
                        ? { stdout: { pattern: "", type: "value" } }
                        : Object.fromEntries(tool.produces.map((k) => [k, { pattern: "", type: "value" }])),
                    ),
                  );
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={() => {
                  // 为工具声明的 produces 生成默认 outputs
                  // 通配符工具（如 slurm）也预填 stdout 作为兜底默认输出
                  const defaultOutputs: Record<string, { pattern: string; type: string }> =
                    tool.produces.includes("*") || tool.produces.length === 0
                      ? { stdout: { pattern: "", type: "value" } }
                      : Object.fromEntries(tool.produces.map((k) => [k, { pattern: "", type: "value" }]));
                  addNode("custom", undefined, undefined, tool.name, defaultOutputs);
                }}
                title={tool.description}
              >
                <span className="wf-palette-icon" style={{ background: "#8b5cf6" }}>
                  <Boxes size={14} />
                </span>
                {tool.name}
              </button>
            ))}
            <div className="wf-palette-divider" />
          </>
        )}
        {/* 数据变换预设 */}
        {TRANSFORM_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="wf-palette-btn"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("application/workflow-node", "transform");
              e.dataTransfer.setData("application/workflow-preset", preset.id);
              e.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => addNode("transform", preset.id)}
          >
            <span className="wf-palette-icon" style={{ background: preset.color }}>
              <preset.icon size={14} />
            </span>
            {t(preset.labelKey)}
          </button>
        ))}
      </div>
    </Panel>
  );
}

export interface EditorToolbarProps {
  workflowId?: string;
  /** 运行中 / 版本预览态下整条工具栏只读（新建按钮隐藏、保存禁用） */
  readOnly: boolean;
  previewVersion: number | null;
  saveStatus: "idle" | "saving" | "saved" | "unsaved";
  yamlOpen: boolean;
  running: boolean;
  onNew: () => void;
  onAutoLayout: () => void;
  onSaveDraft: () => void;
  /** 打开 / 收起 YAML 滑出面板（编辑器在打开时把当前 YAML 存为比对基准） */
  onToggleYaml: () => void;
  onDryRun: () => void;
  onRun: () => void;
}

export function EditorToolbar({
  workflowId,
  readOnly,
  previewVersion,
  saveStatus,
  yamlOpen,
  running,
  onNew,
  onAutoLayout,
  onSaveDraft,
  onToggleYaml,
  onDryRun,
  onRun,
}: EditorToolbarProps) {
  const { t } = useTranslation("workflows");

  return (
    <Panel position="top-center" className="wf-panel-toolbar">
      <div className="wf-toolbar">
        {!readOnly && (
          <button type="button" className="wf-toolbar-btn" onClick={onNew} data-tooltip={t("editor.tooltip_new")}>
            <FilePlus size={15} />
          </button>
        )}
        <button
          type="button"
          className="wf-toolbar-btn"
          onClick={onAutoLayout}
          data-tooltip={t("editor.tooltip_layout")}
        >
          <LayoutGrid size={15} />
        </button>
        {workflowId && (
          <>
            <div className="wf-toolbar-divider" />
            <button
              type="button"
              className={`wf-toolbar-btn ${saveStatus === "unsaved" ? "text-amber-500" : ""}`}
              onClick={onSaveDraft}
              disabled={saveStatus === "saving" || previewVersion !== null}
              data-tooltip={
                saveStatus === "saving"
                  ? t("editor.saving")
                  : saveStatus === "unsaved"
                    ? t("editor.tooltip_save_unsaved")
                    : t("editor.tooltip_save")
              }
            >
              {saveStatus === "saving" ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}
            </button>
          </>
        )}
        <button
          type="button"
          className={`wf-toolbar-btn ${yamlOpen ? "active" : ""}`}
          onClick={onToggleYaml}
          data-tooltip={t("editor.tooltip_yaml")}
        >
          <Code size={15} />
        </button>
        <div className="wf-toolbar-divider" />
        <button
          type="button"
          className="wf-toolbar-btn"
          onClick={onDryRun}
          disabled={running}
          data-tooltip={t("editor.tooltip_validate")}
        >
          <CheckCircle size={15} />
        </button>
        <button
          type="button"
          className="wf-toolbar-btn"
          onClick={onRun}
          disabled={running}
          data-tooltip={t("editor.tooltip_run")}
          style={running ? { opacity: 0.5 } : undefined}
        >
          <Play size={15} />
        </button>
      </div>
    </Panel>
  );
}
