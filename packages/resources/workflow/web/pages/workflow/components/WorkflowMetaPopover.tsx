import { Popover, PopoverContent, PopoverTrigger } from "@fenix/ui-components/ui/popover";
import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WfMeta } from "../yaml-utils";
import { PopoverHeader } from "./PopoverHeader";
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
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" className="wf-meta-trigger-btn" title={t("editor.meta_settings")}>
          <Settings size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={8} collisionPadding={16} className="wf-meta-popover">
        <PopoverHeader title={t("editor.meta_settings")} />
        <WorkflowMetaCard readOnly={readOnly} meta={meta} updateMeta={updateMeta} />
      </PopoverContent>
    </Popover>
  );
}
