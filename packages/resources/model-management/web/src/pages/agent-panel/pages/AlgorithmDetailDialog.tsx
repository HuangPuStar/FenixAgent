import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MODELS_NS } from "../../../../i18n/namespace";
import { copyTextToClipboard } from "../../../../lib/clipboard";
import type { Algorithm } from "./AlgorithmsPage";

interface AlgorithmDetailDialogProps {
  algorithm: Algorithm;
  open: boolean;
  onClose: () => void;
}

export function AlgorithmDetailDialog({ algorithm, open, onClose }: AlgorithmDetailDialogProps) {
  const { t } = useTranslation(MODELS_NS);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      {/* className 与 size="xl" 的合并结果：sm 断点以上仍是 960px（`sm:max-w-[960px]` 与无修饰符的
          `max-w-[680px]` 分属两个分组，谁也压不过谁），680px 只在窄屏生效；`max-h-[85vh]` / `overflow-auto`
          则确实覆盖了变体默认的 90vh / overflow-hidden。这是原 XLDialog 版本的实际渲染结果，
          size 变体化时逐字保留，未顺手改动视觉。 */}
      <DialogContent size="xl" className="p-6 max-w-[680px] max-h-[85vh] overflow-auto">
        {/* 头部 */}
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-blue-50 to-blue-100 flex items-center justify-center text-lg flex-shrink-0">
              {algorithm.emoji}
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-bold">{algorithm.name}</DialogTitle>
              <p className="text-xs text-text-secondary mt-0.5">{algorithm.categories.join(" · ")}</p>
            </div>
            {/* 复制反馈走 toast（与算法卡片的复制按钮共用 lib/clipboard）：按钮文案不再为 2 秒回落切成「已复制」。 */}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 h-8 text-xs flex-shrink-0"
              onClick={() =>
                copyTextToClipboard(algorithm.code, {
                  copied: t("algorithms.copied"),
                  failed: t("algorithms.copyFailed"),
                })
              }
            >
              <Copy className="w-3.5 h-3.5" />
              {t("algorithms.copyCode")}
            </Button>
          </div>
        </DialogHeader>

        {/* 内容两栏 */}
        <div className="flex gap-5 mt-4">
          {/* 左栏 */}
          <div className="flex-1 min-w-0">
            <h4 className="text-xs font-bold text-text-primary mb-1.5">{t("algorithms.introHeading")}</h4>
            <p className="text-xs text-text-secondary leading-relaxed mb-4">{algorithm.description}</p>

            <h4 className="text-xs font-bold text-text-primary mb-2">{t("algorithms.paramsHeading")}</h4>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-0 border-b border-border">
                  <th className="text-left p-2 font-semibold text-text-muted">{t("algorithms.columns.param")}</th>
                  <th className="text-left p-2 font-semibold text-text-muted">
                    {t("algorithms.columns.defaultValue")}
                  </th>
                  <th className="text-left p-2 font-semibold text-text-muted">{t("algorithms.columns.description")}</th>
                </tr>
              </thead>
              <tbody>
                {algorithm.params.map((p) => (
                  <tr key={p.name} className="border-b border-border-light">
                    <td className="p-2 font-mono text-text-primary">{p.name}</td>
                    <td className="p-2 font-mono text-text-primary">{p.default}</td>
                    <td className="p-2 text-text-secondary">{p.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {algorithm.scenes.length > 0 && (
              <>
                <h4 className="text-xs font-bold text-text-primary mt-4 mb-2">{t("algorithms.scenesHeading")}</h4>
                <div className="flex gap-1.5 flex-wrap">
                  {algorithm.scenes.map((s) => (
                    <span key={s} className="text-[11px] text-text-secondary bg-surface-1 px-2 py-0.5 rounded">
                      {s}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* 右栏：代码块 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-text-muted font-semibold tracking-wider">PYTHON</span>
            </div>
            <pre className="bg-slate-900 text-slate-200 rounded-lg p-4 text-xs leading-relaxed font-mono overflow-x-auto">
              <code>{algorithm.code}</code>
            </pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
