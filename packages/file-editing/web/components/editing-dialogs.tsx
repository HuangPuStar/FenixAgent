import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fenix/ui-components/ui/alert-dialog";
import { Button } from "@fenix/ui-components/ui/button";
import { useTranslation } from "react-i18next";
import { isExpiredOfficeBuffer } from "../hooks/editing-errors";
import type { FileEditingController } from "../hooks/types";
import { FILE_EDITING_NS } from "../i18n/namespace";

/** Mount once above tabs so close and navigation decisions remain visible without an active pane. */
export function EditingDialogs({ controller }: { controller: FileEditingController }) {
  const { t } = useTranslation(FILE_EDITING_NS);
  const guard = controller.guard;
  const expiredOffice = guard?.paths.some((path) => isExpiredOfficeBuffer(controller.buffers[path])) ?? false;
  return (
    <AlertDialog
      open={guard !== null}
      onOpenChange={(open) => {
        if (!open) void controller.resolveGuard("cancel");
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("leaveTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(expiredOffice ? "expiredLeaveDescription" : "leaveDescription", {
              paths: guard?.paths.join(", ") ?? "",
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {guard?.error && (
          <p role="alert" className="text-sm text-red-500">
            {t(guard.error.message, { defaultValue: guard.error.message })}
          </p>
        )}
        <AlertDialogFooter>
          <Button
            variant="outline"
            disabled={guard?.busy}
            onClick={() => {
              void controller.resolveGuard("cancel");
            }}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={guard?.busy}
            onClick={() => {
              void controller.resolveGuard("discard");
            }}
          >
            {t("discard")}
          </Button>
          {!expiredOffice && (
            <Button
              disabled={guard?.busy}
              onClick={() => {
                void controller.resolveGuard("save");
              }}
            >
              {t(guard?.busy ? "saving" : "save")}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
