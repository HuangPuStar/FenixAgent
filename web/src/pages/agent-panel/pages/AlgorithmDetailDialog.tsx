import { Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { XLDialog, XLDialogContent, XLDialogHeader, XLDialogTitle } from "@/components/ui/dialog-xl";
import type { Algorithm } from "./AlgorithmsPage";

interface AlgorithmDetailDialogProps {
  algorithm: Algorithm;
  open: boolean;
  onClose: () => void;
}

export function AlgorithmDetailDialog({ algorithm, open, onClose }: AlgorithmDetailDialogProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(algorithm.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <XLDialog open={open} onOpenChange={(v) => !v && onClose()}>
      <XLDialogContent className="max-w-[680px] max-h-[85vh] overflow-auto">
        {/* 头部 */}
        <XLDialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-blue-50 to-blue-100 flex items-center justify-center text-lg flex-shrink-0">
              {algorithm.emoji}
            </div>
            <div className="flex-1 min-w-0">
              <XLDialogTitle className="text-base font-bold">{algorithm.name}</XLDialogTitle>
              <p className="text-xs text-text-secondary mt-0.5">{algorithm.categories.join(" · ")}</p>
            </div>
            <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs flex-shrink-0" onClick={handleCopy}>
              <Copy className="w-3.5 h-3.5" />
              {copied ? "已复制" : "复制代码"}
            </Button>
          </div>
        </XLDialogHeader>

        {/* 内容两栏 */}
        <div className="flex gap-5 mt-4">
          {/* 左栏 */}
          <div className="flex-1 min-w-0">
            <h4 className="text-xs font-bold text-text-primary mb-1.5">算法简介</h4>
            <p className="text-xs text-text-secondary leading-relaxed mb-4">{algorithm.description}</p>

            <h4 className="text-xs font-bold text-text-primary mb-2">核心参数</h4>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-surface-0 border-b border-border">
                  <th className="text-left p-2 font-semibold text-text-muted">参数</th>
                  <th className="text-left p-2 font-semibold text-text-muted">默认值</th>
                  <th className="text-left p-2 font-semibold text-text-muted">说明</th>
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
                <h4 className="text-xs font-bold text-text-primary mt-4 mb-2">适用场景</h4>
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
      </XLDialogContent>
    </XLDialog>
  );
}
