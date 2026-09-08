import { ChevronDown, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PendingPermission } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import { Button } from "../ui/button";

// =============================================================================
// 权限请求面板 — 固定在输入框上方（Anthropic warm token style）
// =============================================================================

interface PermissionPanelProps {
  requests: PendingPermission[];
  onRespond?: (requestId: string, optionId: string | null) => void;
  className?: string;
}

export function PermissionPanel({ requests, onRespond, className }: PermissionPanelProps) {
  if (requests.length === 0) return null;

  return (
    <div className={cn("chat-interaction-stack", className)}>
      <div className="space-y-2">
        {requests.map((req) => (
          <PermissionCard key={req.requestId} request={req} onRespond={onRespond} />
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// 单个权限卡片 — warm warning tokens + left-border accent
// =============================================================================

interface PermissionCardProps {
  request: PendingPermission;
  onRespond?: (requestId: string, optionId: string | null) => void;
}

function PermissionCard({ request, onRespond }: PermissionCardProps) {
  const { t } = useTranslation("components");
  const [collapsed, setCollapsed] = useState(false);
  const inputSummary = Object.keys(request.toolInput).length > 0 ? JSON.stringify(request.toolInput) : null;
  return (
    <section className="chat-interaction-region" aria-label={t("permissionPanel.title")}>
      <header>
        <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
          <span className="chat-interaction-icon">
            <KeyRound />
          </span>
          <strong>{t("permissionPanel.title")}</strong>
          <small>{t("permissionPanel.waiting")}</small>
          <ChevronDown className={collapsed ? "is-collapsed" : undefined} />
        </button>
      </header>
      {!collapsed && (
        <div className="chat-permission-body">
          <div className="chat-permission-copy">
            <span>{t("permissionPanel.aboutToRun")}</span>
            <strong>{request.toolName}</strong>
            {request.description && <p>{request.description}</p>}
          </div>
          {inputSummary && <code>{inputSummary}</code>}
          <p className="chat-permission-audit">
            <ShieldCheck />
            {t("permissionPanel.audit")}
          </p>
          <footer>
            {(request.options ?? []).map((option) => (
              <Button
                key={option.optionId}
                type="button"
                variant={
                  option.kind.startsWith("reject") ? "ghost" : option.kind === "allow_once" ? "default" : "outline"
                }
                size="sm"
                onClick={() => onRespond?.(request.requestId, option.optionId)}
              >
                {option.name}
              </Button>
            ))}
          </footer>
        </div>
      )}
    </section>
  );
}
