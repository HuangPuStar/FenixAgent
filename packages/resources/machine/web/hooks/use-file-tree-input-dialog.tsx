import { FileTreeInputDialog } from "@fenix/ui-components/components/file-tree-input-dialog";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MACHINE_NS } from "../i18n/namespace";
import type { useFileTreeOperations } from "./use-file-tree-operations";

const MAX_FILE_NAME_BYTES = 255;

/** UTF-8 字节上限与服务端 NAME_MAX 契约一致。 */
export function getFileTreeNameByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** 文件名必须为单个 basename，不允许目录分隔符或特殊目录标识。 */
export function isValidFileTreeBasename(value: string): boolean {
  const trimmed = value.trim();
  return (
    !!trimmed &&
    !trimmed.includes("\0") &&
    !trimmed.includes("/") &&
    trimmed !== "." &&
    trimmed !== ".." &&
    getFileTreeNameByteLength(value) <= MAX_FILE_NAME_BYTES
  );
}

/** 完整移动路径的服务端边界校验仍由文件 Facade 负责。 */
export function isValidFileTreeMovePath(value: string): boolean {
  return !!value.trim() && !value.includes("\0");
}

type InputKind = "rename" | "move" | "newFile" | "newFolder";
interface InputState {
  kind: InputKind;
  path: string;
  value: string;
  error?: string;
}

/** 统一编排既有新建、重命名与完整路径移动弹窗。 */
export function useFileTreeInputDialog(
  operations: ReturnType<typeof useFileTreeOperations>,
  closeContextMenu: () => void,
) {
  const { t } = useTranslation(MACHINE_NS);
  const { t: tUi } = useTranslation(NS.UI_COMPONENTS);
  const [input, setInput] = useState<InputState | null>(null);
  const texts = {
    rename: { title: t("fileTree.dialog.renameTitle"), description: t("fileTree.dialog.renameDescription") },
    move: { title: t("fileTree.dialog.moveTitle"), description: t("fileTree.dialog.moveDescription") },
    newFile: { title: t("fileTree.dialog.newFileTitle"), description: t("fileTree.dialog.newFileDescription") },
    newFolder: { title: t("fileTree.dialog.newFolderTitle"), description: t("fileTree.dialog.newFolderDescription") },
  };
  function open(kind: InputKind, path: string, value = "") {
    if (operations.busy) return;
    setInput({ kind, path, value });
    closeContextMenu();
  }
  async function submit() {
    if (!input || operations.busy) return;
    const basename = input.kind !== "move";
    if (basename ? !isValidFileTreeBasename(input.value) : !isValidFileTreeMovePath(input.value)) {
      const error = basename
        ? getFileTreeNameByteLength(input.value) > MAX_FILE_NAME_BYTES
          ? t("fileTree.dialog.nameTooLong")
          : t("fileTree.dialog.invalidName")
        : t("fileTree.dialog.invalidPath");
      setInput({ ...input, error });
      return;
    }
    let success: boolean;
    if (input.kind === "rename" || input.kind === "move") {
      const parent = input.path.includes("/") ? input.path.slice(0, input.path.lastIndexOf("/")) : "";
      const destination = input.kind === "move" ? input.value : parent ? `${parent}/${input.value}` : input.value;
      success = await operations.renamePath(input.path, destination);
    } else {
      const path = input.path ? `${input.path}/${input.value}` : input.value;
      success = await operations.createPath(path, input.kind === "newFolder");
    }
    if (success) setInput(null);
  }
  const text = input ? texts[input.kind] : null;
  return {
    open,
    dialog: (
      <FileTreeInputDialog
        open={input !== null}
        title={text?.title ?? ""}
        description={text?.description ?? ""}
        value={input?.value ?? ""}
        error={input?.error}
        submitting={operations.busy}
        confirmLabel={t("fileTree.dialog.confirm")}
        cancelLabel={tUi("confirmDialog.cancel")}
        onValueChange={(value) => setInput((current) => (current ? { ...current, value, error: undefined } : null))}
        onOpenChange={(opened) => {
          if (!opened && !operations.busy) setInput(null);
        }}
        onSubmit={() => {
          void submit();
        }}
      />
    ),
  };
}
