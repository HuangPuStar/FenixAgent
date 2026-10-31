/**
 * 切换到「公开共享」前的固定文案确认框。
 *
 * 公开的语义不止"别人能看到"：运行该智能体会直接用上它声明的 Skill / MCP / 模型与 Provider / 知识库 /
 * 机器 / 沙盒池——这些依赖按配置直接用、不再过滤权限。因此风险点必须一次列全，让用户在开启前逐项确认。
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fenix/ui-components/ui/alert-dialog";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useTranslation } from "react-i18next";

/** 会被公开共享一并暴露的依赖资源类别（文案键与后端资源一一对应）。 */
const EXPOSED_RESOURCES = ["skill", "mcp", "model", "knowledgeBase", "machine", "sandboxPool"] as const;

export function AgentPublicShareDialog({
  open,
  onOpenChange,
  onCloseAutoFocus,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(NS.AGENTS);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("resource.publicWarningTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("resource.publicWarningDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {EXPOSED_RESOURCES.map((key) => (
            <li key={key}>{t(`resource.publicWarningItems.${key}`)}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("dialog.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t("resource.publicWarningConfirm")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
