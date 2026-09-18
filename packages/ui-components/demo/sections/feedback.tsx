import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  FormDialog,
  Input,
  Label,
  Progress,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  XLDialog,
  XLDialogClose,
  XLDialogContent,
  XLDialogHeader,
  XLDialogTitle,
  XLDialogTrigger,
} from "@fenix/ui-components";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * 反馈分区：AlertDialog / ConfirmDialog / FormDialog / Dialog / XLDialog / Sheet / Progress。
 *
 * 覆盖「确认、危险操作、加载中」三类状态：危险操作由 AlertDialog 的 destructive 动作承担，
 * 普通确认由 Dialog / XLDialog / Sheet 承担，加载中由 ConfirmDialog、FormDialog 的 loading
 * 与 Progress 承担。
 *
 * 已知限制：包内没有 Toast / Notification 类组件。
 * 影响范围：瞬时提示只能靠弹窗内文案与 Progress 表达，本分区缺少自动消失的轻提示示例。
 * 移除条件：包内新增 toast 组件后，在本分区补一个对应小节。
 *
 * 导出名被 demo/App.tsx 引用，新增示例时保持导出名与签名不变。
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

export function FeedbackSection() {
  const { t } = useTranslation(DEMO_NS);
  const confirm = useSimulatedPending();
  const form = useSimulatedPending();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.feedback")}</h1>

      <div className="demo-example">
        <h2 className="demo-example-title">AlertDialog</h2>
        <div className="demo-field">
          <p className="demo-hint">危险操作的二次确认：取消按钮默认聚焦，动作按钮使用 destructive 变体。</p>
          <div className="demo-row">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline">Delete workspace</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete workspace?</AlertDialogTitle>
                  <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => setLastEvent("Delete confirmed (simulated)")}>
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">ConfirmDialog</h2>
        <div className="demo-field">
          <p className="demo-hint">
            受控确认弹窗：确认后进入 loading，按钮文案切换为 Processing 且取消一并禁用，模拟请求结束后关闭。
          </p>
          <div className="demo-row">
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

      <div className="demo-example">
        <h2 className="demo-example-title">FormDialog</h2>
        <div className="demo-field">
          <p className="demo-hint">表单弹窗：未传 formConfig 时走原生的 onSubmit，提交按钮共享同一 loading 状态。</p>
          <div className="demo-row">
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
            <div className="demo-field">
              <Label htmlFor="demo-project-name">Name</Label>
              <Input id="demo-project-name" placeholder="my-project" />
              <Label htmlFor="demo-project-owner">Owner</Label>
              <Input id="demo-project-owner" placeholder="team@example.com" />
            </div>
          </FormDialog>
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Dialog / XLDialog</h2>
        <div className="demo-field">
          <p className="demo-hint">
            常规弹窗与 960px 的超大弹窗；两者都是 Radix Dialog 的封装，XLDialog 只放开宽度与内边距。
          </p>
          <div className="demo-row">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Archive session</DialogTitle>
                  <DialogDescription>Archived sessions stay readable but reject new prompts.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost">Cancel</Button>
                  </DialogClose>
                  <Button onClick={() => setLastEvent("Session archived (simulated)")}>Archive</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <XLDialog>
              <XLDialogTrigger asChild>
                <Button variant="outline">Open XL dialog</Button>
              </XLDialogTrigger>
              <XLDialogContent>
                <XLDialogHeader className="border-b p-6">
                  <XLDialogTitle>Agent trace</XLDialogTitle>
                </XLDialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto p-6 text-sm text-muted-foreground">
                  XLDialog 主体自行滚动，适合长内容与图文混排；下面的页脚保持固定高度。
                </div>
                <div className="flex justify-end gap-2 border-t p-4">
                  <XLDialogClose asChild>
                    <Button variant="outline">Close</Button>
                  </XLDialogClose>
                </div>
              </XLDialogContent>
            </XLDialog>
          </div>
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Sheet</h2>
        <div className="demo-field">
          <p className="demo-hint">
            侧滑抽屉：side 支持 right / left / top / bottom，进出场动画依赖 tw-animate-css（见浮层分区说明）。
          </p>
          <div className="demo-row">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Open sheet</Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>Filters</SheetTitle>
                  <SheetDescription>Adjust the filters, then apply them to the list.</SheetDescription>
                </SheetHeader>
                <div className="flex flex-1 flex-col gap-4 px-4">
                  <div className="demo-field">
                    <Label htmlFor="demo-sheet-query">Keyword</Label>
                    <Input id="demo-sheet-query" placeholder="Search sessions" />
                  </div>
                </div>
                <SheetFooter>
                  <Button onClick={() => setLastEvent("Filters applied (simulated)")}>Apply</Button>
                  <SheetClose asChild>
                    <Button variant="outline">Close</Button>
                  </SheetClose>
                </SheetFooter>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">Progress</h2>
        <div className="demo-field">
          <p className="demo-hint">Progress 只表达确定进度（0-100）；不确定耗时的加载态用按钮或弹窗的 loading。</p>
          <div className="demo-column">
            <div className="demo-field">
              <div className="demo-row">
                <span className="text-sm">Uploading files</span>
                <span className="text-sm text-muted-foreground">70%</span>
              </div>
              <Progress value={70} />
            </div>
            <div className="demo-field">
              <div className="demo-row">
                <span className="text-sm">Indexing documents</span>
                <span className="text-sm text-muted-foreground">35%</span>
              </div>
              <Progress value={35} />
            </div>
          </div>
        </div>
      </div>

      {lastEvent ? <p className="demo-hint">Last callback: {lastEvent}</p> : null}
    </section>
  );
}
