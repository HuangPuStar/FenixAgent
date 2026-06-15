import { Eye, EyeOff } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { encryptPassword } from "@/src/lib/password-crypto";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const { t } = useTranslation(NS.SETTINGS);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

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

        const res = await fetch("/api/auth/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            currentPassword: encCurrent,
            newPassword: encNew,
            revokeOtherSessions: false,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.message || t("changeFailed"));
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
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">{t("currentPassword")}</label>
            <div className="relative">
              <input
                type={showCurrent ? "text" : "password"}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 pr-10 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <button
                type="button"
                onClick={() => setShowCurrent(!showCurrent)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                tabIndex={-1}
              >
                {showCurrent ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">{t("newPassword")}</label>
            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 pr-10 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <button
                type="button"
                onClick={() => setShowNew(!showNew)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                tabIndex={-1}
              >
                {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">{t("confirmPassword")}</label>
            <div className="relative">
              <input
                type={showConfirm ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 pr-10 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <button
                type="button"
                onClick={() => setShowConfirm(!showConfirm)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                tabIndex={-1}
              >
                {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

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
