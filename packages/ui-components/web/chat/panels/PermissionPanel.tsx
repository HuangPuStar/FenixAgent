// =============================================================================
// 权限请求面板 — 固定在输入框上方（Anthropic warm token style）
//
// 复制自 packages/agent-runtime/web/components/chat/PermissionPanel.tsx。
// 纯化改动：PendingPermission 改从包内 ../types 导入（不依赖 @fenix/* 与宿主 @/src）；
//   cn 改为包内 ../../lib/cn；Button 改为包内 ../../ui/button；
//   i18n 由宿主 ns=components 收敛到 UI_COMPONENTS_NS 的 chat.components.* key。
//   视觉、结构、交互与 data-* 契约均未改动。
// =============================================================================

import { ChevronDown, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import type { PendingPermission } from "../types";

interface PermissionPanelProps {
  requests: PendingPermission[];
  onRespond?: (requestId: string, optionId: string | null) => void;
  className?: string;
}

/**
 * 权限请求面板：把待确认的 ACP 权限请求渲染成输入框上方的暖色警示卡片列表。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/PermissionPanel.tsx`。
 * 纯化改动：类型、cn、Button 与 i18n 改为包内导入；请求数据与应答全部由 props 注入，
 * 组件自身不订阅任何传输或会话状态；空列表返回 null（不占位）。
 */
export function PermissionPanel({ requests, onRespond, className }: PermissionPanelProps) {
  if (requests.length === 0) return null;

  return (
    <div
      // 源 `chat-design-status.css` 的 `.chat-interaction-stack`：比输入岛卡片每侧窄 16px 的台阶。
      className={cn("mx-auto w-[min(756px,calc(100%-64px))] [@media(max-width:720px)]:w-[calc(100%-52px)]", className)}
      data-slot="chat-interaction-stack"
    >
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
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [collapsed, setCollapsed] = useState(false);
  const inputSummary = Object.keys(request.toolInput).length > 0 ? JSON.stringify(request.toolInput) : null;
  return (
    <section
      // 源 `.chat-interaction-region`：只有上半有圆角的「用户权威」半圆卡。
      className="overflow-hidden rounded-t-[14px] border-x border-t border-b-0 border-[#dde4ee] bg-white shadow-[0_12px_34px_rgb(30_64_120_/_8%)]"
      data-slot="chat-permission-region"
      aria-label={t("chat.components.permissionPanel.title")}
    >
      <header>
        <button
          type="button"
          // 源 `.chat-interaction-region > header button`（+ strong/small/末位 svg 与折叠态旋转）
          className="flex min-h-[40px] w-full items-center gap-[9px] px-3 py-1.5 text-[#33445d]"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span className="grid h-[25px] w-[25px] place-items-center rounded-[7px] bg-[#eef4ff] text-[#2d69db] [&>svg]:h-3.5 [&>svg]:w-3.5">
            <KeyRound />
          </span>
          <strong className="text-[13px]">{t("chat.components.permissionPanel.title")}</strong>
          <small className="text-[11px] text-[#8a96a8]">{t("chat.components.permissionPanel.waiting")}</small>
          <ChevronDown className={cn("ml-auto w-[15px]", collapsed && "-rotate-90")} />
        </button>
      </header>
      {!collapsed && (
        <div className="px-[14px] pt-0.5 pb-[13px]">
          <div>
            <span className="block text-[11px] text-[#8a96a8]">{t("chat.components.permissionPanel.aboutToRun")}</span>
            <strong className="mt-[3px] block text-[14px] text-[#26364f]">{request.toolName}</strong>
            {request.description && <p className="mt-[3px] text-[12px] text-[#718096]">{request.description}</p>}
          </div>
          {inputSummary && (
            <code className="mt-[9px] block overflow-hidden rounded-[7px] bg-[#f5f7fa] px-[10px] py-2 text-[11px] text-ellipsis whitespace-nowrap text-[#55657d]">
              {inputSummary}
            </code>
          )}
          <p className="mt-2 flex items-center gap-[5px] text-[11px] text-[#7f8ca0] [&>svg]:h-[13px] [&>svg]:w-[13px]">
            <ShieldCheck />
            {t("chat.components.permissionPanel.audit")}
          </p>
          <footer className="mt-[11px] flex justify-end gap-[7px]">
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
