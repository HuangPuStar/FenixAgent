import { Key, Lock, Eye, EyeOff } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { encryptPassword } from "@/src/lib/password-crypto";

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const { t } = useTranslation("login");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showOldPassword, setShowOldPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError("");

      // 验证新密码
      if (newPassword !== confirmPassword) {
        setError(t("passwordMismatch"));
        return;
      }

      if (newPassword.length < 8) {
        setError(t("passwordPlaceholder"));
        return;
      }

      setLoading(true);

      try {
        // 加密旧密码和新密码
        const [encOldPassword, encNewPassword] = await Promise.all([
          encryptPassword(oldPassword),
          encryptPassword(newPassword),
        ]);

        // TODO: 调用后端API修改密码
        // 示例：await authApi.changePassword({ oldPassword: encOldPassword, newPassword: encNewPassword });
        console.log("Change password:", { encOldPassword, encNewPassword });

        toast.success(t("changePasswordSuccess"));
        onOpenChange(false);
        // 清空表单
        setOldPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } catch (err) {
        setError(err instanceof Error ? err.message : t("unknownError"));
      } finally {
        setLoading(false);
      }
    },
    [oldPassword, newPassword, confirmPassword, t, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            {t("changePassword")}
          </DialogTitle>
          <DialogDescription>{t("changePassword")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="old-password">{t("oldPassword")}</Label>
            <InputGroup>
              <InputGroupAddon>
                <Key className="h-4 w-4" />
              </InputGroupAddon>
              <InputGroupInput
                id="old-password"
                type={showOldPassword ? "text" : "password"}
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                required
                minLength={8}
                placeholder={t("passwordPlaceholder")}
              />
              <InputGroupAddon>
                <button
                  type="button"
                  onClick={() => setShowOldPassword(!showOldPassword)}
                  className="p-1 text-text-muted hover:text-text-primary"
                  tabIndex={-1}
                >
                  {showOldPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </InputGroupAddon>
            </InputGroup>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-password">{t("newPassword")}</Label>
            <InputGroup>
              <InputGroupAddon>
                <Lock className="h-4 w-4" />
              </InputGroupAddon>
              <InputGroupInput
                id="new-password"
                type={showNewPassword ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                placeholder={t("passwordPlaceholder")}
              />
              <InputGroupAddon>
                <button
                  type="button"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                  className="p-1 text-text-muted hover:text-text-primary"
                  tabIndex={-1}
                >
                  {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </InputGroupAddon>
            </InputGroup>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">{t("confirmNewPassword")}</Label>
            <InputGroup>
              <InputGroupAddon>
                <Lock className="h-4 w-4" />
              </InputGroupAddon>
              <InputGroupInput
                id="confirm-password"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                placeholder={t("passwordPlaceholder")}
              />
              <InputGroupAddon>
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="p-1 text-text-muted hover:text-text-primary"
                  tabIndex={-1}
                >
                  {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </InputGroupAddon>
            </InputGroup>
          </div>

          {error && <p className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{error}</p>}

          <div className="flex gap-2 justify-end">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? t("pleaseWait") : t("save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
