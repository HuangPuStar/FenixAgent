import { MountSiteDialog } from "@fenix/agent-config/web";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

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
      {/* 卸载确认走库里的 `ConfirmDialog`（原为手写 AlertDialog：与库组件同构，且自己复刻了一份
          `confirmDialog.cancel` / `confirmDialog.processing` 文案）。文案仍由宿主字典提供，
          避免弹窗里中英混排。 */}
      <ConfirmDialog
        open={unmountTarget !== null}
        onOpenChange={onUnmountOpenChange}
        title={t("panelMode.unmountConfirmTitle")}
        description={unmountTarget ? t("panelMode.unmountConfirm", { name: unmountTarget.name }) : ""}
        confirmLabel={t("panelMode.unmountSite")}
        cancelLabel={t("confirmDialog.cancel")}
        loading={unmounting}
        onConfirm={() => {
          if (unmountTarget) onConfirmUnmount(unmountTarget.id);
        }}
      />
    </>
  );
}
