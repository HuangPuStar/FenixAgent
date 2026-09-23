// web/pages/agent-panel/components/knowledge-import-dialog.tsx
// **导入 RAGFlow 知识库**的两段式弹窗：第一段列出远端未关联的知识库，第二段让用户改成本地名称后确认。
// 纯受控——远端列表、加载态与正在导入的是哪一个都在 `use-knowledge-base-catalog` 里。
//
// 从 `AgentKnowledgeBasesPage.tsx` 拆出（§4.7）：导入是独立于「建库 / 删库」的一条数据流
// （自己的列表请求、自己的两段式弹窗状态），与前后的确认弹窗只是位置相邻。

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { BookOpen, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UnassociatedKnowledgeBase } from "../../../types/knowledge";

interface KnowledgeImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 远端列表加载中 */
  loading: boolean;
  /** RAGFlow 里存在、本平台尚未关联的知识库 */
  items: UnassociatedKnowledgeBase[];
  /** 正在导入的远端 id：该行的按钮进入禁用 + 转圈态 */
  importingId: string | null;
  /** 点「导入」先进入第二段的改名确认（不直接发请求） */
  onRequestImport: (item: UnassociatedKnowledgeBase) => void;
  /** 第二段：改名后确认导入 */
  rename: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    target: UnassociatedKnowledgeBase | null;
    value: string;
    onValueChange: (value: string) => void;
    /** 确认导入：名称非空才发请求 */
    onConfirm: () => void;
    /** 取消：关弹窗并清掉改名目标 */
    onCancel: () => void;
  };
}

export function KnowledgeImportDialog(props: KnowledgeImportDialogProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("importDialog.title")}</DialogTitle>
            <DialogDescription>{t("importDialog.description")}</DialogDescription>
          </DialogHeader>
          <div className="max-h-100 overflow-y-auto -mx-6 px-6">
            {props.loading ? (
              <Spinner label={t("importDialog.loading")} className="flex py-16" />
            ) : props.items.length === 0 ? (
              <EmptyState
                className="py-16"
                icon={<BookOpen />}
                title={t("importDialog.emptyTitle")}
                description={t("importDialog.emptyDescription")}
              />
            ) : (
              <div className="space-y-2 py-2">
                {props.items.map((ds) => (
                  <div
                    key={ds.id}
                    className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-indigo-500/30 hover:bg-slate-50"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-50 to-violet-50 ring-1 ring-inset ring-indigo-500/10">
                        <BookOpen className="h-4 w-4 text-indigo-500" />
                      </div>
                      <span className="text-sm font-medium text-slate-900 break-all">{ds.name}</span>
                    </div>
                    <Button
                      size="sm"
                      disabled={props.importingId === ds.id}
                      onClick={() => props.onRequestImport(ds)}
                      className="h-8 gap-1.5 text-xs rounded-lg shrink-0 ml-3"
                    >
                      <Download className="h-3.5 w-3.5" />
                      导入
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ===== 重命名导入弹窗 ===== */}
      <Dialog open={props.rename.open} onOpenChange={props.rename.onOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("importDialog.renameTitle")}</DialogTitle>
            <DialogDescription>{t("importDialog.renameDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-medium text-slate-600">{t("importDialog.nameLabel")}</label>
              <Input
                value={props.rename.value}
                onChange={(e) => props.rename.onValueChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && props.rename.value.trim()) {
                    props.rename.onConfirm();
                  }
                }}
                placeholder={t("importDialog.namePlaceholder")}
                className="h-10 text-sm"
                autoFocus
                onFocus={(e) => e.target.select()}
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button variant="outline" onClick={props.rename.onCancel} className="h-9 text-xs rounded-lg">
                取消
              </Button>
              <Button
                disabled={props.importingId === props.rename.target?.id || !props.rename.value.trim()}
                onClick={props.rename.onConfirm}
                className="h-9 text-xs rounded-lg"
              >
                {props.importingId === props.rename.target?.id ? (
                  <>
                    {/* text-current：跟随按钮前景色，环在填充底上才看得见 */}
                    <Spinner size="xs" className="text-current" />
                    导入中
                  </>
                ) : (
                  "确认导入"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
