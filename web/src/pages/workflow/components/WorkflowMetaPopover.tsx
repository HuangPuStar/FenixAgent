import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { WfMeta } from "../yaml-utils";
import { WorkflowMetaCard } from "./WorkflowMetaCard";

export interface WorkflowMetaPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  readOnly: boolean;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
}

export function WorkflowMetaPopover({ open, onOpenChange, readOnly, meta, updateMeta }: WorkflowMetaPopoverProps) {
  const { t } = useTranslation("workflows");

  return (
    <div className="wf-meta-popover-anchor">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button type="button" className="wf-meta-trigger-btn" title={t("editor.meta_settings")}>
            <Settings size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" sideOffset={8} collisionPadding={16} className="wf-meta-popover">
          <div className="wf-popover-header">
            <span className="wf-popover-title">{t("editor.meta_settings")}</span>
          </div>
          <WorkflowMetaCard readOnly={readOnly} meta={meta} updateMeta={updateMeta} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
