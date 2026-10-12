/**
 * 评论表单：新建与编辑**同构**（`mode` 只差按钮文案与「有没有取消」）。
 *
 * 同构的理由：两者的输入、校验、禁用条件、错误位完全一致，差别只有提交动作和按钮文字。拆成两个组件会让
 * 「编辑态忘了禁用输入」这类不一致长期存在，而它们本该同生共死。
 *
 * **校验放在这里而不是写路径 hook 里**：空内容与超长是「这份输入不成立」，不是「这次写失败了」——它不该
 * 触发请求、也不该进幂等账本。校验文案用键（`validation.*`）而不是已翻译的字符串，避免绕过 `t()`。
 * 写失败（409 冲突、403）才由调用方经 `errorMessage` 传入，两者共用同一行 `role="alert"`。
 */

import { Button } from "@fenix/ui-components/ui/button";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TICKETS_NS } from "../../../i18n/namespace";

/**
 * 评论长度上限。与后端 `MESSAGE_MAX_BYTES`（64 KiB 字节）同源，但这里是**字符**数的粗粒度预检：
 * 客户端不复制服务端「拼上身份头再量 UTF-8 字节」的算法，超限最终仍以服务端判定为准。
 */
const COMMENT_MAX_CHARS = 64 * 1024;

export interface TicketCommentComposerProps {
  mode: "create" | "edit";
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** 编辑态的取消；新建态不传（没有「取消」可言）。 */
  onCancel?: () => void;
  submitting: boolean;
  /** 有待确认的写、或别的写动作进行中：输入与按钮一并禁用（同一工单同一时刻只允许一笔写）。 */
  disabled: boolean;
  /** 写失败的内联提示（如 409 的 `write.conflict`），已翻译。 */
  errorMessage?: string;
  /** 冲突时的「加载最新内容」入口；不传即不渲染该按钮。 */
  onReload?: () => void;
  reloading?: boolean;
}

export function TicketCommentComposer({
  mode,
  value,
  onChange,
  onSubmit,
  onCancel,
  submitting,
  disabled,
  errorMessage,
  onReload,
  reloading = false,
}: TicketCommentComposerProps) {
  const { t } = useTranslation(TICKETS_NS);
  /** 本地校验提示（i18n 键）；一次输入变化即清掉，避免用户改完还看着旧报错。 */
  const [localError, setLocalError] = useState<string | null>(null);

  const handleChange = (next: string): void => {
    setLocalError(null);
    onChange(next);
  };

  const handleSubmit = (): void => {
    if (value.trim().length === 0) {
      setLocalError("validation.commentRequired");
      return;
    }
    if (value.length > COMMENT_MAX_CHARS) {
      setLocalError("validation.commentMax");
      return;
    }
    setLocalError(null);
    onSubmit();
  };

  const message = localError === null ? errorMessage : t(localError);

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-invalid={message === undefined ? undefined : true}
        aria-label={t("comment.placeholder")}
        className="min-h-24"
        disabled={disabled || submitting}
        onChange={(event) => handleChange(event.target.value)}
        placeholder={t("comment.placeholder")}
        value={value}
      />
      {message === undefined ? null : (
        <p className="text-xs text-status-error" role="alert">
          {message}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={disabled || submitting} onClick={handleSubmit} size="sm" type="button">
          {mode === "create" ? t("comment.submit") : t("comment.save")}
        </Button>
        {mode === "edit" && onCancel !== undefined ? (
          <Button disabled={submitting} onClick={onCancel} size="sm" type="button" variant="ghost">
            {t("comment.cancel")}
          </Button>
        ) : null}
        {message !== undefined && onReload !== undefined ? (
          <Button className="ml-auto" disabled={reloading} onClick={onReload} size="sm" type="button" variant="outline">
            <RefreshCw className="size-3.5" />
            {t("write.reload")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
