export const ARTIFACTS_PREVIEW_FILE_EVENT = "artifacts:preview-file";

export interface ArtifactsPreviewFileDetail {
  envId: string;
  path: string;
}

// 路径校验的实现已下沉到 `@fenix/ui-components`（2026-09-22 去重）：本文件与 MessageBubble 里
// 那份逐字相同的副本合并为一份，安全判据只剩一个改动点。此处按原样转发，本包导出的名字与子路径
// （`@fenix/web-runtime/lib/artifacts-preview-events` 的 `isWorkspaceRelativeFilePath`）不变，
// 消费方与包内测试零改动。
export { isWorkspaceRelativeFilePath } from "@fenix/ui-components/lib/workspace-relative-path";

/** 派发带 environment 隔离信息的文件预览请求。 */
export function dispatchArtifactsPreviewFile(envId: string, path: string): void {
  window.dispatchEvent(
    new window.CustomEvent<ArtifactsPreviewFileDetail>(ARTIFACTS_PREVIEW_FILE_EVENT, { detail: { envId, path } }),
  );
}

/** 解析当前 environment 的文件预览事件；其他 environment 的事件按隔离要求忽略。 */
export function getArtifactsPreviewFileDetail(event: Event, envId: string | null): ArtifactsPreviewFileDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!envId || typeof detail !== "object" || detail === null) return null;
  const candidate = detail as Partial<ArtifactsPreviewFileDetail>;
  if (candidate.envId !== envId || typeof candidate.path !== "string" || candidate.path.length === 0) return null;
  return { envId, path: candidate.path };
}
