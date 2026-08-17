import { beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type DragEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FileInfo } from "../types";

// 设置最小 DOM 环境（React 19 需要 window + document）
const win = new Window();
const g = globalThis as Record<string, unknown>;
if (!g.window) g.window = win;
if (!g.document) g.document = win.document;
if (!g.navigator) g.navigator = win.navigator;

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

// 记录 fsApi.upload 实际发出的请求，供断言 URL 与 FormData
const fetchMock = {
  lastUrl: "",
  method: "",
  body: null as BodyInit | null | undefined,
};

// 上传成功响应：v2 fsApi 返回 workspace 相对路径（无 user/ 前缀）
const UPLOAD_RESPONSE = {
  success: true,
  data: { files: [{ name: "report.txt", path: "report.txt", size: 7 }] },
};

beforeEach(() => {
  fetchMock.lastUrl = "";
  fetchMock.method = "";
  fetchMock.body = null;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchMock.lastUrl = String(input);
    fetchMock.method = init?.method ?? "GET";
    fetchMock.body = init?.body ?? null;
    return new Response(JSON.stringify(UPLOAD_RESPONSE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

const { useDragUpload } = await import("../../components/chat/useDragUpload");

// 构造最小可用的拖拽事件（仅提供 handleDrop 依赖的 dataTransfer.files）
function dropEvent(files: File[]): DragEvent {
  return {
    preventDefault: () => {},
    dataTransfer: { files },
  } as unknown as DragEvent;
}

// 拖拽上传走 fsApi.upload：构造含 files 字段的 FormData，POST 到 workspace 根（/fs/，不带 targetDir）
test("拖拽上传构造 FormData 并 POST 到 /web/environments/:id/fs/", async () => {
  const onUploaded = mock(() => {});
  const { result, unmount } = renderHook(() => useDragUpload({ envId: "env_1", onUploaded, onError: mock(() => {}) }));
  const file = new File(["content"], "report.txt");

  await act(async () => {
    await result.current.handleDrop(dropEvent([file]));
  });

  expect(fetchMock.lastUrl).toBe("/web/environments/env_1/fs/");
  expect(fetchMock.method).toBe("POST");
  expect(fetchMock.body).toBeInstanceOf(FormData);
  const fd = fetchMock.body as FormData;
  // File 经 FormData 存取后可能丢失引用身份，按结构（name/size）断言字段内容
  expect(fd.get("files")).toEqual(file);
  unmount();
});

// 上传成功后回填 workspace 相对路径：v2 上传到根目录，path 不再强制加 user/ 前缀
test("上传成功后 onUploaded 携带 workspace 相对路径（无 user/ 前缀）", async () => {
  const onUploaded = mock((_file: FileInfo) => {});
  const { result, unmount } = renderHook(() => useDragUpload({ envId: "env_1", onUploaded, onError: mock(() => {}) }));
  const file = new File(["content"], "report.txt");

  await act(async () => {
    await result.current.handleDrop(dropEvent([file]));
  });

  expect(onUploaded).toHaveBeenCalledTimes(1);
  const info = onUploaded.mock.calls[0][0];
  expect(info.name).toBe("report.txt");
  expect(info.path).toBe("report.txt");
  expect(info.type).toBe("file");
  unmount();
});

// 超过 100MB 的单文件直接跳过（与 FilePickerPanel 上限一致），不发起上传并回调 onError
test("超过 100MB 的文件跳过上传并触发 onError", async () => {
  const onError = mock(() => {});
  const { result, unmount } = renderHook(() => useDragUpload({ envId: "env_1", onUploaded: mock(() => {}), onError }));
  const bigFile = new File([new Uint8Array(100 * 1024 * 1024 + 1)], "big.bin");

  await act(async () => {
    await result.current.handleDrop(dropEvent([bigFile]));
  });

  expect(onError).toHaveBeenCalledTimes(1);
  expect(fetchMock.lastUrl).toBe("");
  unmount();
});
