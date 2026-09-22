import { Button, ConfirmDialog, FormDialog, Input, Label } from "@fenix/ui-components";
import { useEffect, useRef, useState } from "react";

/**
 * 对话框容器示例：ConfirmDialog / FormDialog。
 *
 * 这一组只讲「通用对话框容器」：契约与业务无关，任何宿主都可以直接复用，
 * 共同边界是「字段状态、校验错误与异步提交都由调用方持有」—— 组件只负责弹窗结构、
 * loading 期间的动作按钮禁用与提交/确认事件，因此示例里的校验和请求都在本文件内模拟，不涉及接口调用。
 *
 * 文件树的单字段弹窗（FileTreeInputDialog）带文件系统语义（表头文案、新建/改名流程），
 * 已随文件域迁到 File L2 分区，不再属于本层。
 */

/** 模拟一次异步提交的耗时；接入真实业务时替换为请求 Promise 即可，其余演示逻辑不变。 */
const SIMULATED_LATENCY_MS = 1200;

/**
 * 演示用的「异步提交」状态：进入 pending，1.2s 后复位并执行完成回调。
 *
 * demo 没有后端，只能靠定时器展示 loading；句柄存在 ref 中并在卸载时清理，避免切换分区或 HMR
 * 后向已卸载组件写入状态。pending 期间重复触发会被忽略，防止定时器叠加导致回调执行多次。
 */
function useSimulatedPending(): { pending: boolean; start: (onSettled?: () => void) => void } {
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  function start(onSettled?: () => void) {
    if (timerRef.current !== null) return;
    setPending(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPending(false);
      onSettled?.();
    }, SIMULATED_LATENCY_MS);
  }

  return { pending, start };
}

export function DialogContainerExamples() {
  const confirm = useSimulatedPending();
  const form = useSimulatedPending();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  return (
    <>
      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          ConfirmDialog
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            受控确认弹窗：确认后进入 loading，按钮文案切换为 Processing 且取消一并禁用，模拟请求结束后关闭。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => setConfirmOpen(true)}>
              Revoke API keys
            </Button>
          </div>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Revoke all API keys?"
            description="Existing clients lose access immediately. This cannot be undone."
            confirmLabel="Revoke"
            variant="destructive"
            loading={confirm.pending}
            onConfirm={() => {
              confirm.start(() => {
                setConfirmOpen(false);
                setLastEvent("API keys revoked (simulated)");
              });
            }}
          />
        </div>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          FormDialog
        </h2>
        <div className="flex flex-col gap-1.5">
          <p className="mt-3 text-text-muted text-[12px]">
            表单弹窗：未传 formConfig 时走原生的 onSubmit，提交按钮共享同一 loading 状态。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" onClick={() => setFormOpen(true)}>
              Create project
            </Button>
          </div>
          <FormDialog
            open={formOpen}
            onOpenChange={setFormOpen}
            title="Create project"
            submitLabel="Create"
            loading={form.pending}
            onSubmit={() => {
              form.start(() => {
                setFormOpen(false);
                setLastEvent("Project created (simulated)");
              });
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="demo-project-name">Name</Label>
              <Input id="demo-project-name" placeholder="my-project" />
              <Label htmlFor="demo-project-owner">Owner</Label>
              <Input id="demo-project-owner" placeholder="team@example.com" />
            </div>
          </FormDialog>
        </div>
      </div>

      {lastEvent ? <p className="mt-3 text-text-muted text-[12px]">Last callback: {lastEvent}</p> : null}
    </>
  );
}
