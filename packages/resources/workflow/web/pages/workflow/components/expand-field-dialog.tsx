import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Textarea } from "@fenix/ui-components/ui/textarea";

/**
 * 「展开编辑」弹窗的状态：哪个字段、当前值、回写方式。
 *
 * 状态由 `NodeConfigCard` 顶层持有（整张卡片共用一个弹窗实例），字段组件只把这三样交给它——
 * 见 `node-config-fields.tsx` 的 `BlockField`。这样做的原因：卡片里同类字段有十几处，若每个字段
 * 自带一个 Dialog，弹窗数量会随字段数增长；共用一个实例后，DOM 与非展开字段完全无关。
 */
export interface ExpandState {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

/** 代码块字段的展开编辑弹窗（受控：`expand === null` 即关闭）。 */
export function ExpandFieldDialog({
  expand,
  readOnly,
  onClose,
}: {
  expand: ExpandState | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={expand !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="wf-code-dialog" style={{ maxWidth: 640, width: "90vw" }}>
        <DialogHeader>
          <DialogTitle>{expand?.label}</DialogTitle>
        </DialogHeader>
        <Textarea
          value={expand?.value ?? ""}
          onChange={(e) => expand?.onChange(e.target.value)}
          placeholder={expand?.placeholder}
          rows={20}
          readOnly={readOnly}
          className="font-mono text-sm"
        />
      </DialogContent>
    </Dialog>
  );
}
