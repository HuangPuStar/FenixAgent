import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Eye, EyeOff } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { SETTINGS_NS } from "../i18n/namespace";
import { authClient } from "../lib/auth-client";
import { encryptPassword } from "../lib/password-crypto";

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 密码输入行：三个字段此前逐字重复同一段「label + 相对定位容器 + 输入框 + 显隐按钮」的 JSX，
 * 连两串类名都各抄三份。抽成组件后类名、显隐行为与 `tabIndex` 只有一处定义，
 * 掩码切换的状态也随之收进组件内部（外层不再需要三个 `show*` 状态）。
 */
function PasswordField({
  label,
  value,
  onChange,
  minLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label className="block text-sm font-medium text-text-secondary mb-1">{label}</label>
      <div className="relative">
        <input
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          minLength={minLength}
          className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 pr-10 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
          tabIndex={-1}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  // 命名空间常量取自本包的 i18n 出口：字典 owner 是本包（§1.6 T9 由宿主搬入），
  // 宿主只负责在启动时把它注册到同名命名空间。
  const { t } = useTranslation(SETTINGS_NS);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const resetForm = useCallback(() => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
    setSuccess(false);
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError("");

      if (newPassword.length < 8) {
        setError(t("passwordTooShort"));
        return;
      }
      if (newPassword !== confirmPassword) {
        setError(t("passwordsMismatch"));
        return;
      }

      setLoading(true);
      try {
        const encCurrent = await encryptPassword(currentPassword);
        const encNew = await encryptPassword(newPassword);

        // 经 better-auth 客户端提交：该端点属库内核路由，客户端方法自带同一 POST 与 { error } 契约，
        // 传输由库内的 createFetch 持有（不经 request()，见前端规范 §5.3 例外登记）。
        // 服务端消息仍从 error.message 原样取出，失败提示与手写 fetch 版本一致。
        const { error: submitError } = await authClient.changePassword({
          currentPassword: encCurrent,
          newPassword: encNew,
          revokeOtherSessions: false,
        });
        if (submitError) {
          setError(submitError.message || t("changeFailed"));
          return;
        }

        setSuccess(true);
        setTimeout(() => {
          onOpenChange(false);
          resetForm();
        }, 1500);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("unknownError"));
      } finally {
        setLoading(false);
      }
    },
    [currentPassword, newPassword, confirmPassword, t, onOpenChange, resetForm],
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) resetForm();
      onOpenChange(open);
    },
    [onOpenChange, resetForm],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("changePassword")}</DialogTitle>
          <DialogDescription>{t("changePasswordDesc")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <PasswordField label={t("currentPassword")} value={currentPassword} onChange={setCurrentPassword} />

          <PasswordField label={t("newPassword")} value={newPassword} onChange={setNewPassword} minLength={8} />

          <PasswordField
            label={t("confirmPassword")}
            value={confirmPassword}
            onChange={setConfirmPassword}
            minLength={8}
          />

          {error && <p className="text-sm text-status-error bg-status-error/10 px-3 py-2 rounded-md">{error}</p>}
          {success && (
            <p className="text-sm text-status-success bg-status-success/10 px-3 py-2 rounded-md">
              {t("changeSuccess")}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || success}
            className="w-full rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-50"
          >
            {loading ? t("pleaseWait") : t("changePassword")}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
