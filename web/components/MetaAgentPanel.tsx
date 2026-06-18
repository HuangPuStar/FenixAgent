import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { ChatPanel } from "../src/pages/agent-panel/ChatPanel";

export interface MetaAgentPanelProps {
  /** 面板是否展开 */
  chatOpen: boolean;
  /** 设置面板展开状态 */
  setChatOpen: (open: boolean) => void;
  /** Meta Agent environment ID */
  metaAgentId: string | null;
  /** 可选的场景提示，workflow 场景传入 workflow 上下文，skills 场景不传 */
  scenePrompt?: string;
  /** 上下文标识：变化时自动触发新会话 */
  contextKey?: string;
  /** 会话完成后的回调，如刷新数据 */
  onPromptComplete?: () => void;
  /**
   * toggle 拉手按钮位置。
   * - `"right"`（默认）：拉手在面板右侧，适用于 workflow 编辑器（面板在画布左侧）
   * - `"left"`：拉手在面板左侧，适用于 skills 等面板在页面右侧的场景
   */
  togglePosition?: "left" | "right";
}

/**
 * Meta Agent 嵌入式聊天面板。
 *
 * 设计要点：
 * - 不再自带顶部 header（ChatPanel 内部的 ChatHeader 已提供会话标题/历史 popover）
 * - 始终保留一个拉手按钮，双向 toggle 展开/收起，位置由 togglePosition 控制
 * - 收起状态下仅渲染拉手，避免占用过多横向空间
 */
export function MetaAgentPanel({
  chatOpen,
  setChatOpen,
  metaAgentId,
  scenePrompt,
  contextKey,
  onPromptComplete,
  togglePosition = "right",
}: MetaAgentPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  const isLeft = togglePosition === "left";

  // 面板边框方向：拉手在左时面板右边框、拉手在右时面板左边框（贴拉手侧无边框）
  const panelBorder = isLeft
    ? { borderRight: "1px solid var(--color-border-subtle)" }
    : { borderLeft: "1px solid var(--color-border-subtle)" };

  // 拉手箭头的语义：
  // - 拉手在左：展开态显示右箭头（收起面板）、收起态显示左箭头（展开面板）
  // - 拉手在右：展开态显示左箭头（收起面板）、收起态显示右箭头（展开面板）
  const chevronIcon = (() => {
    if (chatOpen) return isLeft ? <ChevronRight size={14} /> : <ChevronLeft size={14} />;
    return isLeft ? <ChevronLeft size={14} /> : <ChevronRight size={14} />;
  })();

  const toggleBtn = (
    <button
      type="button"
      className={`meta-agent-toggle-btn${chatOpen ? " open" : ""}${isLeft ? " left" : ""}`}
      onClick={() => setChatOpen(!chatOpen)}
      title={chatOpen ? t("metaAgent.chat_collapse") : t("metaAgent.chat_expand")}
      aria-label={chatOpen ? t("metaAgent.chat_collapse") : t("metaAgent.chat_expand")}
      aria-expanded={chatOpen}
    >
      {chevronIcon}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "row", height: "100%" }}>
      {/* 拉手在左时先渲染拉手 */}
      {isLeft && toggleBtn}

      {/* 主面板 — 仅在展开时渲染，避免收起后继续持有 ACP 连接 */}
      {chatOpen && (
        <div
          // meta-agent-panel: 作为窄屏样式的作用域钩子，CSS 在 web/src/index.css 中按该类名收紧 padding、
          // 隐藏 agent avatar、简化 ChatComposer 元信息条
          className="meta-agent-panel"
          style={{
            width: 400,
            minWidth: 400,
            display: "flex",
            flexDirection: "column",
            background: "#fff",
            ...panelBorder,
            position: "relative",
          }}
        >
          {/* 聊天区域 — ChatHeader 内部已提供历史会话 popover，无需外层 header */}
          <div style={{ flex: 1, overflow: "hidden" }}>
            <ChatPanel
              agentId={metaAgentId}
              hideSidebar
              scenePrompt={scenePrompt}
              contextKey={contextKey}
              onPromptComplete={onPromptComplete}
            />
          </div>
        </div>
      )}

      {/* 拉手在右时在后面渲染拉手 */}
      {!isLeft && toggleBtn}
    </div>
  );
}
