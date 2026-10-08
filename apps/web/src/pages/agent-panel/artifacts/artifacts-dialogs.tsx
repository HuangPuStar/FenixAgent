/**
 * `ArtifactsPanel` 的 Sites 模式弹窗：站点挂载（`MountSiteDialog`）与卸载确认（`ConfirmDialog`）。
 *
 * 归属：`ArtifactsPanel` 的私有件，随它同住 `apps/web/src/pages/agent-panel/artifacts/`（2026-09-28 由
 * `apps/web/src/shell/artifacts/` 归位，见 `ArtifactsPanel.tsx` 文件头）。它不持有状态也不取数——开关与
 * 目标全在站点域 hook（`@fenix/agent-config/web` 的 `useArtifactsSites`）里，本文件只把两个对话框接到那套
 * 状态上；同时消费 agent-config 与 ui-components 的弹窗，故进不了任何单一资源包。
 *
 * 文案的 owner 按 §9.2 分属三个命名空间：标题与描述是宿主面板自己的（`components`），确认动作是站点域的
 * （`agents`），取消按钮与组件库默认值同源（`uiComponents`）——见下方逐条注释。
 */

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
  // 站点卸载动作的词条 owner 是 `@fenix/agent-config`（台账 D4 把 `panelMode.*` 的站点部分迁出宿主
  // `components` 字典）；`confirmDialog.cancel` 的 owner 是 `@fenix/ui-components`（`ConfirmDialog`
  // 同名默认文案），宿主组件库消费方一律按该包命名空间取。
  const { t: tAgents } = useTranslation(NS.AGENTS);
  const { t: tUi } = useTranslation(NS.UI_COMPONENTS);
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
          `confirmDialog.cancel` / `confirmDialog.processing` 文案）。取消词条与库组件默认值同源
          （`@fenix/ui-components` 的 `confirmDialog.cancel`），中英不会因此混排。 */}
      <ConfirmDialog
        open={unmountTarget !== null}
        onOpenChange={onUnmountOpenChange}
        title={t("panelMode.unmountConfirmTitle")}
        description={unmountTarget ? t("panelMode.unmountConfirm", { name: unmountTarget.name }) : ""}
        confirmLabel={tAgents("panelMode.unmountSite")}
        cancelLabel={tUi("confirmDialog.cancel")}
        loading={unmounting}
        onConfirm={() => {
          if (unmountTarget) onConfirmUnmount(unmountTarget.id);
        }}
      />
    </>
  );
}
