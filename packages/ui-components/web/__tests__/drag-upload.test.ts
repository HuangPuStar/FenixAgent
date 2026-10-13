import { beforeEach, expect, mock, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement, type DragEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ComposerFileInfo } from "../chat/composer/composer-file-processing";
import { useDragUpload } from "../chat/composer/useDragUpload";

/**
 * 拖拽上传（`web/chat/composer/useDragUpload`）的行为测试。
 *
 * 来源：`packages/agent-runtime/web/__tests__/drag-upload.test.ts` 迁移。
 * 纯化差异：源实现直连宿主 `uploadChatFiles(envId, files)`，测试靠 mock `globalThis.fetch`
 * 同时验证请求 URL 与 FormData；包内上传改为注入端口（`uploadFiles`），请求 URL / FormData 由
 * 宿主装配决定（其覆盖见 `apps/web/src/__tests__/fs-upload-url.test.ts` 的
 * 「always uploads to the user file area」），包内只对「拖拽文件交给注入的上传回调」
 * 「服务端返回的路径原样进入 onUploaded」「超限文件不上传」负责。
 * 本 hook 无 i18n 文案（超限提示是源实现逐字保留的硬编码中文），故不初始化包内字典。
 */

// 设置最小 DOM 环境（React 19 需要 window + document）
const win = initializeHappyDomWindow(new Window());
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
// React 19 的 act 环境标记，缺失时 act 不批处理更新
g.IS_REACT_ACT_ENVIRONMENT = true;

// 简易 renderHook（项目无 @testing-library/react，用 react-dom/client 手写）
function renderHook<T>(hookFn: () => T): {
  result: { current: T };
  unmount: () => void;
} {
  const result: { current: T } = {} as never;
  let root: Root | null = null;
  const container = win.document.createElement("div");

  function Comp() {
    result.current = hookFn();
    return null as unknown as ReactNode;
  }

  root = createRoot(container as unknown as HTMLElement);
  act(() => {
    root!.render(createElement(Comp));
  });

  return {
    result,
    unmount: () =>
      act(() => {
        root!.unmount();
        root = null;
      }),
  };
}

// 记录注入的上传端口收到的文件，供断言拖拽链路是否发起上传
const uploadCalls: File[][] = [];

beforeEach(() => {
  uploadCalls.length = 0;
});

// 构造最小可用的拖拽事件（仅提供 handleDrop 依赖的 dataTransfer.files）
function dropEvent(files: File[]): DragEvent {
  return {
    preventDefault: () => {},
    dataTransfer: { files },
  } as unknown as DragEvent;
}

// 拖拽上传走注入的 uploadChatFiles 端口：把拖入的文件原样交给宿主上传实现，
// 由宿主 POST 到 workspace 的 user/ 目录（包内不再持有请求细节）。
// Chat 用户上传与文件选择器保持一致，避免文件落入 Agent 工作区根目录。
test("拖拽上传把文件交给注入的上传端口", async () => {
  const onUploaded = mock((_file: ComposerFileInfo) => {});
  const uploadFiles = async (files: File[]) => {
    uploadCalls.push(files);
    return [];
  };
  const { result, unmount } = renderHook(() => useDragUpload({ uploadFiles, onUploaded, onError: mock(() => {}) }));
  const file = new File(["content"], "report.txt");

  await act(async () => {
    await result.current.handleDrop(dropEvent([file]));
  });

  expect(uploadCalls.length).toBe(1);
  // File 经闭包传递后仍保持引用身份，按对象相等断言拖入的原始文件未被替换
  expect(uploadCalls[0]?.[0]).toBe(file);
  unmount();
});

// 上传成功后回填 user/ 下的 workspace 相对路径，供聊天引用和文件预览复用。
test("上传成功后 onUploaded 携带 user/ 下的 workspace 相对路径", async () => {
  const onUploaded = mock((_file: ComposerFileInfo) => {});
  // 服务端返回 workspace 相对路径（Chat 上传固定写入 user/ 目录）
  const uploadFiles = async () => [{ name: "report.txt", path: "user/report.txt" }];
  const { result, unmount } = renderHook(() => useDragUpload({ uploadFiles, onUploaded, onError: mock(() => {}) }));
  const file = new File(["content"], "report.txt");

  await act(async () => {
    await result.current.handleDrop(dropEvent([file]));
  });

  expect(onUploaded).toHaveBeenCalledTimes(1);
  const info = onUploaded.mock.calls[0][0];
  expect(info.name).toBe("report.txt");
  expect(info.path).toBe("user/report.txt");
  expect(info.type).toBe("file");
  unmount();
});

// 超过 100MB 的单文件直接跳过（与 FilePickerPanel 上限一致），不发起上传并回调 onError
test("超过 100MB 的文件跳过上传并触发 onError", async () => {
  const onError = mock(() => {});
  const uploadFiles = async (files: File[]) => {
    uploadCalls.push(files);
    return [];
  };
  const { result, unmount } = renderHook(() => useDragUpload({ uploadFiles, onUploaded: mock(() => {}), onError }));
  // 体积判定只读 size / name，用最小替身避免真的分配 100MB 内存
  const bigFile = { size: 100 * 1024 * 1024 + 1, name: "big.bin" } as unknown as File;

  await act(async () => {
    await result.current.handleDrop(dropEvent([bigFile]));
  });

  expect(onError).toHaveBeenCalledTimes(1);
  expect(uploadCalls.length).toBe(0);
  unmount();
});
