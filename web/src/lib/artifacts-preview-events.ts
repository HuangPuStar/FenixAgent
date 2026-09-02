export const ARTIFACTS_PREVIEW_FILE_EVENT = "artifacts:preview-file";

export interface ArtifactsPreviewFileDetail {
  envId: string;
  path: string;
}

/** 校验聊天附件路径仍是 workspace 根相对路径，避免把绝对路径或越界路径送入预览入口。 */
export function isWorkspaceRelativeFilePath(path: string): boolean {
  if (
    !path ||
    path.startsWith("/") ||
    [...path].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** 派发带 environment 隔离信息的文件预览请求。 */
export function dispatchArtifactsPreviewFile(envId: string, path: string): void {
  window.dispatchEvent(
    new CustomEvent<ArtifactsPreviewFileDetail>(ARTIFACTS_PREVIEW_FILE_EVENT, { detail: { envId, path } }),
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
