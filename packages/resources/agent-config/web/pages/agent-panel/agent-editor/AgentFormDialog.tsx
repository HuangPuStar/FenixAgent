import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@fenix/ui-components/ui/sheet";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AgentEditorBody } from "./agent-editor-body";
import { PANEL_DESKTOP, PANEL_SHEET, PANEL_SHELL } from "./agent-editor-classes";
import "./agent-editor-retained.css";
import "./AgentFormDialog.css";

/**
 * 「新建 / 编辑 Agent」面板的属性。
 *
 * `portalContainer` 是桌面面板的 portal 宿主，**同时决定面板的定位与尺寸**：面板是它的 `absolute`
 * 子元素、四周缩进 12px，高度 = 宿主盒高 − 1.5rem。所以宿主必须是撑满可视区的定位容器——壳层传
 * `.agent-panel-body`（整壳右半区，一个视口高），智能体管理页传撑满页面的内容层。传一个只有内容
 * 高度的包裹层，面板就只有那么高（2026-09-23 修的「半屏」：720px 视口下面板 333px）。省略时落到
 * `document.body`，按视口定位（会盖住左侧导航）。
 */
export type AgentFormDialogProps =
  | {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      mode: "create";
      defaultName?: string;
      onSuccess?: (id?: string) => void;
      portalContainer?: HTMLElement | null;
    }
  | {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      mode: "edit";
      agentName: string;
      portalContainer?: HTMLElement | null;
      onSuccess?: never;
      defaultName?: never;
    };

function useMobileEditor(open: boolean) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (!open) return;
    const query = window.matchMedia("(max-width: 759px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [open]);
  return mobile;
}

/**
 * 创建与移动端使用模态容器；桌面编辑是局部 portal 中的非模态工作区。
 *
 * 本组件只是**容器与焦点交接**：决定用移动端 Sheet 还是桌面 portal 工作区、打开/关闭时把焦点
 * 交接给谁，并把关闭处理器经 ref 下发给主体（`agent-editor-body.tsx`，含全部表单状态，见 §4.7）。
 */
export function AgentFormDialog(props: AgentFormDialogProps) {
  const { t } = useTranslation(NS.AGENTS);
  const [mounted, setMounted] = useState(false);
  const mobile = useMobileEditor(props.open);
  const closeHandlerRef = useRef<() => void>(() => props.onOpenChange(false));
  const openerRef = useRef<HTMLElement | null>(null);
  const registerCloseHandler = useCallback((handler: () => void) => {
    closeHandlerRef.current = handler;
  }, []);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (props.open) {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!mobile) {
        requestAnimationFrame(() => document.querySelector<HTMLElement>(".agent-editor-panel[role='dialog']")?.focus());
      }
    } else {
      openerRef.current?.focus();
    }
  }, [mobile, props.open]);

  if (!mounted || !props.open || typeof document === "undefined") return null;

  if (mobile)
    return (
      <Sheet
        open={props.open}
        modal
        onOpenChange={(open) => (open ? props.onOpenChange(true) : closeHandlerRef.current())}
      >
        <SheetContent
          portalContainer={undefined}
          showOverlay={false}
          showCloseButton={false}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            closeHandlerRef.current();
          }}
          className={PANEL_SHEET}
        >
          <SheetTitle className="sr-only">
            {props.mode === "create" ? t("dialog.createTitle") : t("dialog.editTitle")}
          </SheetTitle>
          <SheetDescription className="sr-only">{t("editor.dialogDescription")}</SheetDescription>
          <AgentEditorBody {...props} mobile registerCloseHandler={registerCloseHandler} />
        </SheetContent>
      </Sheet>
    );

  const host = props.portalContainer ?? document.body;
  const dialogTitle = props.mode === "create" ? t("dialog.createTitle") : t("dialog.editTitle");
  return createPortal(
    <section
      className={`${PANEL_SHELL} ${PANEL_DESKTOP}`}
      role="dialog"
      aria-modal="false"
      tabIndex={-1}
      aria-label={dialogTitle}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          closeHandlerRef.current();
        }
      }}
    >
      <AgentEditorBody {...props} mobile={false} registerCloseHandler={registerCloseHandler} />
    </section>,
    host,
  );
}
