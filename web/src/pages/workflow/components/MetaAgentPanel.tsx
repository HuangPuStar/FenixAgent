import { Bot, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ChatPanel } from "../../agent-panel/ChatPanel";

export function MetaAgentPanel({
  chatOpen,
  setChatOpen,
  metaAgentId,
  scenePrompt,
}: {
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  metaAgentId: string | null;
  scenePrompt: string | undefined;
}) {
  const { t } = useTranslation("workflows");

  if (!chatOpen) return null;

  return (
    <div
      style={{
        width: 400,
        minWidth: 400,
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        borderLeft: "1px solid #e5e7eb",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          <Bot size={14} />
          Meta Agent
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button
            type="button"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
              borderRadius: 4,
              color: "#6b7280",
              display: "flex",
              alignItems: "center",
            }}
            onClick={() => setChatOpen(false)}
            title={t("editor.chat_collapse")}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <ChatPanel agentId={metaAgentId} hideSidebar scenePrompt={scenePrompt} />
      </div>
    </div>
  );
}
