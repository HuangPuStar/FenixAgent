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
}

/**
 * Meta Agent 嵌入式聊天面板。
 *
 * 设计要点：
 * - 不再自带顶部 header（ChatPanel 内部的 ChatHeader 已提供会话标题/历史 popover）
 * - 右侧始终保留一个 16px 宽的拉手按钮，位于聊天面板与画布之间，双向 toggle 展开/收起
 * - 收起状态下仅渲染拉手，避免占用过多横向空间
 */
export function MetaAgentPanel({
  chatOpen,
  setChatOpen,
  metaAgentId,
  scenePrompt,
  contextKey,
  onPromptComplete,
}: MetaAgentPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  return (
    <div style={{ display: "flex", flexDirection: "row", height: "100%" }}>
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

      {/* 右侧拉手 — 始终渲染，位于聊天面板与画布之间，样式仿照 .agent-artifacts-expand-btn 的 vertical tab */}
      <button
        type="button"
        className={`meta-agent-toggle-btn${chatOpen ? " open" : ""}`}
        onClick={() => setChatOpen(!chatOpen)}
        title={chatOpen ? t("metaAgent.chat_collapse") : t("metaAgent.chat_expand")}
        aria-label={chatOpen ? t("metaAgent.chat_collapse") : t("metaAgent.chat_expand")}
        aria-expanded={chatOpen}
      >
        {/* 展开时显示左箭头（收起聊天），收起时显示右箭头（展开聊天） */}
        {chatOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>
    </div>
  );
}
