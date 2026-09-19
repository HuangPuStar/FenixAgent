import { CheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/cn";
import { UI_COMPONENTS_NS } from "../../lib/i18n";
import { Button } from "../../ui/button";

/**
 * Permission option 的包内同构类型。
 *
 * 原实现来自宿主会话层业务包（chat-channel）；本包不依赖任何业务包，因此只保留组件实际使用的字段，
 * 并保留索引签名以兼容宿主传入的额外字段（宿主结构无需转换即可直接传入）。
 */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  [key: string]: unknown;
}

// Get button variant based on option kind
function getButtonVariant(kind: PermissionOption["kind"]): "default" | "destructive" | "outline" | "secondary" {
  switch (kind) {
    case "allow_once":
    case "allow_always":
      return "default";
    case "reject_once":
    case "reject_always":
      return "destructive";
    default:
      return "outline";
  }
}

// Get button icon based on option kind
function getButtonIcon(kind: PermissionOption["kind"]) {
  switch (kind) {
    case "allow_once":
    case "allow_always":
      return <CheckIcon className="size-4" />;
    case "reject_once":
    case "reject_always":
      return <XIcon className="size-4" />;
    default:
      return null;
  }
}

// Permission buttons component - used inside Tool component
export interface ToolPermissionButtonsProps {
  requestId: string;
  options: PermissionOption[];
  onRespond: (requestId: string, optionId: string | null, optionKind: PermissionOption["kind"] | null) => void;
  className?: string;
}

export function ToolPermissionButtons({ requestId, options, onRespond, className }: ToolPermissionButtonsProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const handleOptionClick = (option: PermissionOption) => {
    onRespond(requestId, option.optionId, option.kind);
  };

  return (
    <div className={cn("p-3 border-t border-warning-border/30 bg-warning-bg/50", className)}>
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlertIcon className="size-4 text-warning-text" />
        <span className="text-xs font-medium text-warning-text">{t("permissionRequest.title")}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.optionId}
            variant={getButtonVariant(option.kind)}
            size="sm"
            onClick={() => handleOptionClick(option)}
            className="gap-1.5"
          >
            {getButtonIcon(option.kind)}
            {option.name}
          </Button>
        ))}
      </div>
    </div>
  );
}
