import type { ContextMenuItem, ContextMenuOpenContext } from "@pierre/trees";
import { FolderPlus, MessageSquareQuote, Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

interface FileTreeContextMenuProps {
  item: ContextMenuItem;
  context: ContextMenuOpenContext;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onNewFolder: (parentPath: string) => void;
  onReference: (path: string) => void;
}

export function FileTreeContextMenu({
  item,
  context,
  onRename,
  onDelete,
  onNewFolder,
  onReference,
}: FileTreeContextMenuProps): ReactNode {
  const { t } = useTranslation("components");

  const items: Array<{
    label: string;
    icon: typeof Trash2;
    action: () => void;
    danger?: boolean;
  }> = [
    {
      label: t("fileTree.contextMenu.reference"),
      icon: MessageSquareQuote,
      action: () => onReference(item.path),
    },
    ...(item.kind === "file"
      ? [
          {
            label: t("fileTree.contextMenu.rename"),
            icon: Pencil,
            action: () => {
              onRename(item.path);
            },
          },
        ]
      : []),
    {
      label: t("fileTree.contextMenu.delete"),
      icon: Trash2,
      action: () => onDelete(item.path),
      danger: true,
    },
    ...(item.kind === "directory"
      ? [
          {
            label: t("fileTree.contextMenu.newFolder"),
            icon: FolderPlus,
            action: () => onNewFolder(item.path),
          },
        ]
      : []),
  ];

  return (
    <div
      className="rounded-lg border border-border bg-surface-1 p-1 shadow-lg min-w-[160px]"
      data-file-tree-context-menu-root="true"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors ${
            item.danger ? "text-status-error hover:bg-status-error/10" : "text-text-primary hover:bg-surface-2"
          }`}
          onClick={() => {
            item.action();
            context.close({ restoreFocus: false });
          }}
        >
          <item.icon className="h-4 w-4" />
          {item.label}
        </button>
      ))}
    </div>
  );
}
