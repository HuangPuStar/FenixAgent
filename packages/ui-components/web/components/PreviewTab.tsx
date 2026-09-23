/**
 * 预览 tab 容器（从 apps/web 的 `agent-panel/PreviewTab.tsx` 复制并纯化）。
 *
 * 职责：在没有选中文件/环境时给出空态与加载态，否则把渲染完全交给 `FileViewerPreview`。
 * 空态文案 `fileTree.preview.noFileSelected` 已迁入包内字典
 * （`web/i18n/locales/{en,zh}/uiComponents.json`）。
 *
 * 纯化取舍：
 * 1. i18n：`NS.COMPONENTS` → 包内 `UI_COMPONENTS_NS`，其余文案键不变。
 * 2. 保持 `./preview/FileViewerPreview` 相对导入与 `key={filePath}` 重建语义不变：
 *    切换文件时强制重建预览器，避免上一个文件的内部状态（缩放、加载错误）残留。
 * 3. `fetchPreview` 必填、`buildPreviewUrl` 由宿主注入：本组件是宿主 tab 的占位容器，不取数也不拼后端
 *    URL，只把宿主的域模块实现转交给 `FileViewerPreview`（§5.8）；`messages` / `locale` 仍不透传，
 *    需要这些定制时直接用 `FileViewerPreview`。
 */

import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { Spinner } from "../ui/spinner";
import { FileViewerPreview } from "./preview/FileViewerPreview";
import type { PreviewFetch } from "./preview/preview-source";

export interface PreviewTabProps {
  /** 环境标识；缺省时空态区显示加载态（等待宿主补齐上下文）。 */
  envId: string | null;
  /** 选中的 workspace 相对路径；缺省时显示「选择文件以预览」。 */
  filePath: string | null;
  /**
   * 预览 URL 构建器；**宿主必须注入**（`apps/web/src/api/fs.ts` 的 `buildPreviewSourceUrl`），
   * 否则后端 URL 的拼装会留在包内（§5.8）。
   */
  buildPreviewUrl?: (envId: string, filePath: string) => string;
  /**
   * 预览源文件的取数函数；**必填**（`apps/web/src/api/fs.ts` 的 `readPreviewSource`）。
   * 本组件是包内 tab 容器，自身不取数，只把它转交给 `FileViewerPreview`；须为稳定引用（见其同名 prop）。
   */
  fetchPreview: PreviewFetch;
}

export function PreviewTab({ envId, filePath, buildPreviewUrl, fetchPreview }: PreviewTabProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  if (!envId || !filePath) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center p-4">
          {!filePath ? (
            <p className="text-sm text-text-muted">{t("fileTree.preview.noFileSelected")}</p>
          ) : (
            <Spinner size="sm" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col h-full">
      <FileViewerPreview
        key={filePath}
        envId={envId}
        filePath={filePath}
        buildPreviewUrl={buildPreviewUrl}
        fetchPreview={fetchPreview}
      />
    </div>
  );
}
