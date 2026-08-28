// web/src/pages/admin/components/MasterKeyGate.tsx
// 系统 Master Key 输入门（docs/arch/21 §5）：写入 sessionStorage → 触发面板加载。
// 不纳入 better-auth 会话体系；401 由面板层 clearAdminKey() 后带错误提示回到本门。

import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { setAdminKey } from "../../../lib/admin-key";

interface MasterKeyGateProps {
  onUnlock: () => void;
  /** 上次认证失败的错误提示（由面板 401 处理回传）。 */
  error?: string | null;
}

export function MasterKeyGate({ onUnlock, error }: MasterKeyGateProps) {
  const { t } = useTranslation("observer");
  const [key, setKey] = useState("");

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) return;
    setAdminKey(trimmed);
    onUnlock();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-brand" />
            {t("login.title")}
          </CardTitle>
          <CardDescription>{t("login.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={t("login.inputPlaceholder")}
              autoFocus
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={!key.trim()}>
              {t("login.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
