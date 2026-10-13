// pages/list/workflow-api-dialog.tsx
// 「调用接口」弹窗：把「这个工作流怎么被外部系统调用」一次说清——地址、凭据、示例、参数。
//
// 内容全部是**静态事实**（地址由 `window.location.origin` + 本地主键拼出，示例由纯函数生成），因此本组件不取数、
// 也没有 loading/error 三态：需要三态的是「读上游」这类会失败的动作，这里唯一的异步面是复制到剪贴板，反馈必须
// 覆盖成功与失败两种结果（失败不能静默，用户会以为已经复制好了）。
//
// 四段**平铺**而不是收进页签：接入信息是照着写代码时对照着看的，任何一段藏在点两下之后都会让人来回切换；四段
// 加起来在 `sm:max-w-2xl` 里滚一屏即可看完，不需要折叠。
//
// 复制走 `copyDialogTextToClipboard`：模态框内 `navigator.clipboard` 在非安全上下文（自托管常见的 http 部署）
// 是宿主 polyfill 的隐藏 textarea 实现，会被 Radix 的焦点陷阱打断，必须退回「选中框内元素再 execCommand」。
// 因此地址与示例都渲染成带文本节点的 `<code>`（`selectNodeContents` 对 `<input>` 的 value 无效），复制按钮
// 把对应元素传给原语，而不是只传字符串。
//
// 关闭即卸载（Radix 在关闭态不渲染内容）：复制反馈状态随之复位，重新打开不会残留「已复制」。

import { CodeBlock } from "@fenix/ui-components/chat/primitives/code-block";
import { copyDialogTextToClipboard } from "@fenix/ui-components/lib/clipboard";
import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Check, Copy, TriangleAlert, Webhook } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { WORKFLOW_NS } from "../../i18n/namespace";
import { API_KEY_PLACEHOLDER, buildCurlExample, buildRunEndpoint, buildRunUrl } from "./workflow-api-model";

export interface WorkflowApiDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** 本地主键；null 表示目标未确定，此时正文不挂载。 */
  readonly workflowId: string | null;
  /** 标题里的工作流名。 */
  readonly workflowName: string;
}

/** 弹窗尺寸：示例块是长文本，`sm:max-w-2xl` 与同类查看弹窗一致。 */
const DIALOG_CONTENT_CLASS = "sm:max-w-2xl";

/** 复制成功反馈的回落时间；与 `CodeBlockCopyButton` 的默认节奏一致。 */
const COPY_FEEDBACK_MS = 2_000;

/** 复制目标的三种来源；反馈按它区分「刚才复制的是哪一段」。 */
type CopyTarget = "endpoint" | "curl-sync" | "curl-async";

interface CopyState {
  readonly target: CopyTarget;
  readonly ok: boolean;
}

/** 当前控制台 origin；拿不到时回空串（弹窗仍能渲染，地址会以 `/api/...` 相对路径呈现）。 */
function currentOrigin(): string {
  return globalThis.window?.location?.origin ?? "";
}

/**
 * 复制按钮 + 结果反馈。
 *
 * `value` 是写入剪贴板的文本，`elementRef` 指向同一段文本在 DOM 里的容器（降级路径要选中它）：两者必须来自
 * 同一处，否则「界面显示什么」与「复制到什么」会不一致。元素**在点击时**从 ref 取（首帧 ref 还是 null，
 * 把它当 prop 传进来会一直拿到那个 null）。
 */
function CopyButton({
  value,
  elementRef,
  target,
  label,
  state,
  onResult,
}: {
  readonly value: string;
  readonly elementRef: RefObject<HTMLElement | null>;
  readonly target: CopyTarget;
  readonly label: string;
  readonly state: CopyState | null;
  readonly onResult: (result: CopyState) => void;
}) {
  const { t } = useTranslation(WORKFLOW_NS);
  const done = state?.ok === true;
  const failed = state?.ok === false;

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={label}
        onClick={() => {
          void copyDialogTextToClipboard(value, elementRef.current).then((ok) => onResult({ target, ok }));
        }}
      >
        {done ? <Check /> : <Copy />}
        {t("api.copy")}
      </Button>
      {done ? (
        <span role="status" className="text-xs text-text-muted">
          {t("api.copied")}
        </span>
      ) : null}
      {failed ? (
        <span role="alert" className="flex items-center gap-1 text-xs text-status-error">
          <TriangleAlert className="size-3.5" />
          {t("api.copy_failed")}
        </span>
      ) : null}
    </div>
  );
}

/** 参数说明的一行：字段名 + 说明（字段名是协议原文，不进字典）。 */
function ParamRow({ name, description }: { readonly name: string; readonly description: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <code className="font-mono text-xs text-text-bright">{name}</code>
      <span className="text-xs text-text-muted">{description}</span>
    </div>
  );
}

/** 弹窗正文：地址、凭据、示例、参数说明。 */
function WorkflowApiBody({ workflowId }: { readonly workflowId: string }) {
  const { t } = useTranslation(WORKFLOW_NS);
  const [copyState, setCopyState] = useState<CopyState | null>(null);
  const endpointRef = useRef<HTMLElement | null>(null);
  const syncRef = useRef<HTMLDivElement | null>(null);
  const asyncRef = useRef<HTMLDivElement | null>(null);

  const url = buildRunUrl(currentOrigin(), workflowId);
  const { method } = buildRunEndpoint(workflowId);
  const curlSync = buildCurlExample({ url, isAsync: false });
  const curlAsync = buildCurlExample({ url, isAsync: true });
  const authHeader = `Authorization: Bearer ${API_KEY_PLACEHOLDER}`;

  // 反馈 2 秒后回落到默认态；关闭弹窗时组件整体卸载，定时器随之清理。
  useEffect(() => {
    if (copyState === null) return;
    const timer = setTimeout(() => setCopyState(null), COPY_FEEDBACK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copyState]);

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      <section className="flex flex-col gap-2">
        <span className="text-xs font-medium text-text-muted">{t("api.endpoint_label")}</span>
        <div className="flex items-start gap-2">
          <span className="rounded border border-border-subtle px-1.5 py-0.5 font-mono text-xs">{method}</span>
          <code ref={endpointRef} className="min-w-0 flex-1 break-all rounded bg-surface-2 px-2 py-1 font-mono text-xs">
            {url}
          </code>
        </div>
        <CopyButton
          value={url}
          elementRef={endpointRef}
          target="endpoint"
          label={t("api.copy_endpoint")}
          state={copyState?.target === "endpoint" ? copyState : null}
          onResult={setCopyState}
        />
      </section>

      <section className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t("api.auth_title")}</span>
        <p className="text-xs text-text-muted">{t("api.auth_hint")}</p>
        <CodeBlock code={authHeader} language="http" />
      </section>

      <section className="flex flex-col gap-3">
        <span className="text-sm font-medium">{t("api.examples_title")}</span>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">{t("api.example_sync")}</span>
          {/* 降级复制要选中一段**文本节点**：`<input>` 的 value 不是文本节点，因此这里用容器 div 包住代码块。 */}
          <div ref={syncRef}>
            <CodeBlock code={curlSync} language="bash" />
          </div>
          <CopyButton
            value={curlSync}
            elementRef={syncRef}
            target="curl-sync"
            label={t("api.copy_example_sync")}
            state={copyState?.target === "curl-sync" ? copyState : null}
            onResult={setCopyState}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-text-muted">{t("api.example_async")}</span>
          <div ref={asyncRef}>
            <CodeBlock code={curlAsync} language="bash" />
          </div>
          <CopyButton
            value={curlAsync}
            elementRef={asyncRef}
            target="curl-async"
            label={t("api.copy_example_async")}
            state={copyState?.target === "curl-async" ? copyState : null}
            onResult={setCopyState}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("api.params_title")}</span>
        <ParamRow name="parameters" description={t("api.param_parameters")} />
        <ParamRow name="isAsync" description={t("api.param_is_async")} />
        <ParamRow name="ext.user_id" description={t("api.param_ext")} />
        <p className="text-xs text-text-muted">{t("api.params_note")}</p>
      </section>
    </div>
  );
}

export function WorkflowApiDialog({ open, onOpenChange, workflowId, workflowName }: WorkflowApiDialogProps) {
  const { t } = useTranslation(WORKFLOW_NS);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={DIALOG_CONTENT_CLASS}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Webhook className="size-4" />
            {t("api.title", { name: workflowName })}
          </DialogTitle>
          <DialogDescription>{t("api.description")}</DialogDescription>
        </DialogHeader>
        {workflowId === null ? null : <WorkflowApiBody workflowId={workflowId} />}
      </DialogContent>
    </Dialog>
  );
}
