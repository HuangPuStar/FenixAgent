import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useTranslation } from "react-i18next";
import { kbApi } from "../../api/knowledge-bases";
import type { KnowledgeResourceInfo } from "../../types/knowledge";
import { ResourcePreviewContent } from "./ResourcePreviewContent";

interface ResourcePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resource: KnowledgeResourceInfo;
  kbId: string;
}

/** 文件预览对话框，根据资源类型渲染适当的预览视图 */
export function ResourcePreviewDialog({ open, onOpenChange, resource, kbId }: ResourcePreviewDialogProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const fileUrl = kbApi.getFileUrl({ kbId, resourceId: resource.id });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-250 max-w-250 h-[90vh] flex flex-col p-0 gap-0 rounded-2xl overflow-hidden shadow-2xl"
        showCloseButton={false}
      >
        {/* Header：标题 + 下载 + 关闭 */}
        <DialogHeader className="flex-row items-center justify-between px-6 py-4 border-b border-slate-200 shrink-0 bg-gradient-to-r from-gray-50 to-white">
          <DialogTitle className="truncate flex-1 min-w-0 text-sm font-semibold text-slate-900">
            {t("preview.title", { name: resource.sourceName })}
          </DialogTitle>
          <div className="flex items-center gap-2 shrink-0">
            <Button variant="outline" size="sm" asChild>
              <a href={fileUrl} download={resource.sourceName} target="_blank" rel="noreferrer">
                {t("preview.download")}
              </a>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("preview.close")}
            </Button>
          </div>
        </DialogHeader>

        {/* 预览内容区域：复用提取的 ResourcePreviewContent */}
        <div className="flex flex-col flex-1 min-h-0">
          <ResourcePreviewContent resource={resource} kbId={kbId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
