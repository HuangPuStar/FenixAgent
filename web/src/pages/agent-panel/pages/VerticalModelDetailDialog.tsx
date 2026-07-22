import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { VerticalModel } from "./VerticalModelsPage";

interface VerticalModelDetailDialogProps {
  model: VerticalModel;
  open: boolean;
  onClose: () => void;
}

export function VerticalModelDetailDialog({ model, open, onClose }: VerticalModelDetailDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[680px] max-h-[85vh] overflow-auto">
        {/* 头部 */}
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-blue-50 to-blue-100 flex items-center justify-center text-lg flex-shrink-0">
              {model.emoji}
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-bold flex items-center gap-2">
                {model.name}
                <Badge
                  variant="outline"
                  className="bg-amber-50 text-amber-700 border-amber-200 text-[10px] px-1.5 py-0 h-auto"
                >
                  已落地
                </Badge>
              </DialogTitle>
              <p className="text-xs text-text-secondary mt-0.5 flex items-center gap-1.5 flex-wrap">
                <span className="font-mono bg-surface-1 px-1.5 py-px rounded">{model.baseModel}</span>
                <span>{model.modelType}</span>
                <span className="mx-0.5">·</span>
                <span>{model.enterprise}</span>
              </p>
            </div>
          </div>
        </DialogHeader>

        {/* 内容两栏 */}
        <div className="flex gap-5 mt-4">
          {/* 左栏 */}
          <div className="flex-[1.2] min-w-0">
            <h4 className="text-xs font-bold text-text-primary mb-1.5">模型简介</h4>
            <p className="text-xs text-text-secondary leading-relaxed mb-4">{model.description}</p>

            {model.capabilities.length > 0 && (
              <>
                <h4 className="text-xs font-bold text-text-primary mb-2">检测能力</h4>
                <div className="grid grid-cols-2 gap-1">
                  {model.capabilities.map((c) => (
                    <div key={c} className="flex items-center gap-1.5 text-xs text-text-secondary">
                      <span className="text-green-500 text-xs">✓</span>
                      {c}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* 右栏 */}
          <div className="flex-[0.8] min-w-0">
            {model.effects.length > 0 && (
              <>
                <h4 className="text-xs font-bold text-text-primary mb-2">落地效果</h4>
                <div className="flex flex-col gap-2">
                  {model.effects.map((e, i) => {
                    const colors = [
                      "bg-green-50 text-green-700",
                      "bg-blue-50 text-blue-700",
                      "bg-amber-50 text-amber-700",
                    ];
                    const color = colors[i % colors.length];
                    return (
                      <div key={e.metric} className={`flex items-center gap-2.5 rounded-lg p-2.5 ${color}`}>
                        <span className="text-base font-extrabold flex-shrink-0">{e.value}</span>
                        <div className="min-w-0">
                          <div className="text-[11px] font-semibold">{e.metric}</div>
                          <div className="text-[10px] opacity-70">{e.desc}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {model.scenes.length > 0 && (
              <>
                <h4 className="text-xs font-bold text-text-primary mt-4 mb-2">适用场景</h4>
                <div className="flex gap-1 flex-wrap">
                  {model.scenes.map((s) => (
                    <span key={s} className="text-[11px] text-text-secondary bg-surface-1 px-2 py-0.5 rounded">
                      {s}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
