import { expect, mock, test } from "bun:test";
import {
  ARTIFACTS_PREVIEW_FILE_EVENT,
  dispatchArtifactsPreviewFile,
  getArtifactsPreviewFileDetail,
  isWorkspaceRelativeFilePath,
} from "../lib/artifacts-preview-events";

// 聊天附件只允许 workspace 相对文件路径，拒绝绝对路径、越界段和控制字符。
test("validates chat attachment paths before preview", () => {
  expect(isWorkspaceRelativeFilePath("SKILL.md")).toBe(true);
  expect(isWorkspaceRelativeFilePath("docs/spec.md")).toBe(true);
  for (const path of ["", "/tmp/a.txt", "../a.txt", "docs/../a.txt", "docs//a.txt", "docs/\0a.txt"]) {
    expect(isWorkspaceRelativeFilePath(path)).toBe(false);
  }
});

// 文件预览事件携带 environment 与相对路径，当前 environment 才能消费该事件。
test("scopes file preview events to the current environment", () => {
  const event = new CustomEvent(ARTIFACTS_PREVIEW_FILE_EVENT, {
    detail: { envId: "env-a", path: "docs/spec.md" },
  });
  expect(getArtifactsPreviewFileDetail(event, "env-a")).toEqual({ envId: "env-a", path: "docs/spec.md" });
  expect(getArtifactsPreviewFileDetail(event, "env-b")).toBeNull();
  expect(getArtifactsPreviewFileDetail(event, null)).toBeNull();
});

// 统一派发函数不会附带本地 workspace 绝对路径等额外上下文。
test("dispatches the minimal file preview payload", () => {
  const previousWindow = globalThis.window;
  const dispatchEvent = mock((_event: Event) => true);
  globalThis.window = { dispatchEvent } as unknown as Window & typeof globalThis;
  try {
    dispatchArtifactsPreviewFile("env-a", "SKILL.md");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const event = dispatchEvent.mock.calls[0][0] as CustomEvent;
    expect(event.type).toBe(ARTIFACTS_PREVIEW_FILE_EVENT);
    expect(event.detail).toEqual({ envId: "env-a", path: "SKILL.md" });
  } finally {
    globalThis.window = previousWindow;
  }
});
