import type { FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface FileTreeInputDialogProps {
  open: boolean;
  title: string;
  description: string;
  value: string;
  error?: string;
  submitting: boolean;
  confirmLabel: string;
  cancelLabel: string;
  onValueChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}

/** 文件树单字段操作弹窗；字段状态和异步提交由 FileTreeTab 管理。 */
export function FileTreeInputDialog({
  open,
  title,
  description,
  value,
  error,
  submitting,
  confirmLabel,
  cancelLabel,
  onValueChange,
  onOpenChange,
  onSubmit,
}: FileTreeInputDialogProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "file-tree-input-error" : undefined}
              autoFocus
            />
            {error && (
              <p id="file-tree-input-error" className="mt-2 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              {cancelLabel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
