import type { EditingCapabilities } from "@fenix/file-editing/contracts";
import type { EditableKind } from "@fenix/file-editing/web";
import { classifyFile } from "@fenix/ui-components/components/preview/preview-source";

/** Text candidates share the preview's format classifier. */
export function isTextWorkspaceFile(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return (
    ["code", "markdown", "html", "latex"].includes(classifyFile(path)) || extension === "csv" || extension === "tsv"
  );
}

/** Classifies editable formats using the same file categories as the read-only preview. */
export function classifyWorkspaceEditor(
  path: string,
  capabilities?: EditingCapabilities | null,
  size?: number,
): EditableKind | null {
  const office = capabilities?.office;
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (office?.enabled && office.extensions.some((value) => value.replace(/^\./, "").toLowerCase() === extension))
    return "office";
  return capabilities?.text?.enabled === true &&
    (size === undefined || size <= capabilities.textMaxBytes) &&
    isTextWorkspaceFile(path)
    ? "text"
    : null;
}
