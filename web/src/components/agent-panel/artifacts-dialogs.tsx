import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { NS } from "../../i18n";
import { MountSiteDialog } from "./MountSiteDialog";

interface ArtifactsDialogsProps {
  agentConfigId: string | null;
  siteIds: string[];
  mountOpen: boolean;
  onMountOpenChange: (open: boolean) => void;
  onMounted: () => void;
  unmountTarget: { id: string; name: string } | null;
  unmounting: boolean;
  onUnmountOpenChange: (open: boolean) => void;
  onConfirmUnmount: (siteId: string) => void;
}

export function ArtifactsDialogs({
  agentConfigId,
  siteIds,
  mountOpen,
  onMountOpenChange,
  onMounted,
  unmountTarget,
  unmounting,
  onUnmountOpenChange,
  onConfirmUnmount,
}: ArtifactsDialogsProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  return (
    <>
      {agentConfigId && (
        <MountSiteDialog
          open={mountOpen}
          onOpenChange={onMountOpenChange}
          agentConfigId={agentConfigId}
          boundSiteAppIds={siteIds}
          onMounted={onMounted}
        />
      )}
      <AlertDialog open={unmountTarget !== null} onOpenChange={onUnmountOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("panelMode.unmountConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {unmountTarget ? t("panelMode.unmountConfirm", { name: unmountTarget.name }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unmounting}>{t("confirmDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => unmountTarget && onConfirmUnmount(unmountTarget.id)}
              disabled={unmounting}
            >
              {unmounting ? t("confirmDialog.processing") : t("panelMode.unmountSite")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
