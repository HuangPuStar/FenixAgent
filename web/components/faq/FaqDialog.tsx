import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CitationPreviewScope } from "@/components/chat/CitationPreviewScope";
import { agentApi } from "@/src/api/agents";
import { envApi } from "@/src/api/environments";
import { NS } from "@/src/i18n";
import { ChatPanel } from "@/src/pages/agent-panel/ChatPanel";

interface FaqDialogProps {
  onClose: () => void;
}

/**
 * FAQ 对话弹窗 — 查找/创建 FAQ Agent 的运行环境，并内嵌 ChatPanel 进行实时对话。
 *
 * 初始化流程：
 * 1. 按名称 "FAQ" 查找 Agent 配置
 * 2. 查找或创建对应的运行时环境（autoStart 自动 spawn 实例）
 * 3. 将环境 ID 传给 ChatPanel，后续由 ACP relay 自动管理连接与 session
 */
export function FaqDialog({ onClose }: FaqDialogProps) {
  const { t } = useTranslation(NS.FAQ);
  const [faqEnvId, setFaqEnvId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // 1. 查找 FAQ Agent 配置
        const agentResp = await agentApi.get("FAQ");
        if (!agentResp.success || !agentResp.data) {
          if (!cancelled) setError(t("notConfigured"));
          return;
        }
        const agent = agentResp.data;

        // 2. 查找已有环境
        const listResp = await envApi.list({ agentConfigId: agent.id });
        if (!cancelled && listResp.success && Array.isArray(listResp.data) && listResp.data.length > 0) {
          // 复用第一个匹配环境
          setFaqEnvId(listResp.data[0].id);
          setLoading(false);
          return;
        }

        // 3. 创建新环境（autoStart 默认 true，创建后自动 fire-and-forget spawn 实例）
        const createResp = await envApi.create({
          name: "faq-runtime",
          agentConfigId: agent.id,
          autoStart: true,
        });
        if (!cancelled && createResp.success && createResp.data) {
          setFaqEnvId(createResp.data.id);
          setLoading(false);
          return;
        }

        if (!cancelled) setError(t("initError"));
      } catch (err) {
        console.error("[FaqDialog] init error:", err);
        if (!cancelled) setError(t("initError"));
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <div className="faq-dialog-overlay fixed inset-0 z-50" onClick={onClose}>
      {/* 对话框卡片 — 阻止点击穿透关闭 */}
      <div
        className="faq-dialog-card"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="faq-dialog-header">
          <span className="faq-dialog-title">{t("title")}</span>
          <button type="button" onClick={onClose} className="faq-dialog-close-btn" aria-label="Close FAQ chat">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="faq-dialog-body">
          {loading && (
            <div className="flex items-center justify-center h-full text-text-muted text-sm">
              <div className="flex flex-col items-center gap-2">
                <div className="h-5 w-5 rounded-full border-2 border-brand border-t-transparent animate-spin" />
                <span>{t("loading")}</span>
              </div>
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-full text-text-muted text-sm p-4 text-center">
              <span>{error}</span>
            </div>
          )}
          {/* CitationPreviewScope 提供引用预览能力（无 ArtifactsPanel，不传 ref，仅弹 overlay） */}
          {faqEnvId && (
            <CitationPreviewScope>
              <ChatPanel agentId={faqEnvId} hideSidebar />
            </CitationPreviewScope>
          )}
        </div>
      </div>
    </div>
  );
}
