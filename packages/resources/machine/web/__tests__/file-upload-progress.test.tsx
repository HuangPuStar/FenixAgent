import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { useFileUploads } from "../hooks/use-file-uploads";
import { MACHINE_NS, machineResources } from "../i18n";

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "customElements",
  "IS_REACT_ACT_ENVIRONMENT",
  "XMLHttpRequest",
];
const original = new Map(keys.map((key) => [key, globals[key]]));
const i18n = createInstance();
await i18n.init({
  lng: "en",
  initAsync: false,
  defaultNS: MACHINE_NS,
  resources: { en: { [MACHINE_NS]: machineResources.en } },
});

/** 替代浏览器网络边界，保留真实 API 解包、分批与 hook 状态流。 */
class UploadRequest {
  static requests: UploadRequest[] = [];
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  status = 200;
  responseText = JSON.stringify({ success: true, data: { files: [] } });
  onload?: () => void;
  onabort?: () => void;
  onerror?: () => void;
  open() {}
  setRequestHeader() {}
  send() {
    UploadRequest.requests.push(this);
  }
  abort() {
    this.onabort?.();
  }
  progress(percent: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded: percent, total: 100 });
  }
}

let root: Root;
let container: HTMLElement;
let uploads: ReturnType<typeof useFileUploads>;
let completed = 0;
const errors: string[] = [];
let pending: Promise<void> | undefined;

function Harness({ envId }: { envId: string }) {
  uploads = useFileUploads({
    envId,
    onUploaded: () => {
      completed++;
    },
    onError: (message) => errors.push(message),
  });
  return <output>{JSON.stringify({ uploading: uploads.uploading, progress: uploads.uploadProgress })}</output>;
}

function render(envId = "environment") {
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <Harness envId={envId} />
      </I18nextProvider>,
    ),
  );
}

beforeEach(() => {
  Object.assign(globals, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    customElements: win.customElements,
    IS_REACT_ACT_ENVIRONMENT: true,
    XMLHttpRequest: UploadRequest,
  });
  UploadRequest.requests = [];
  completed = 0;
  errors.length = 0;
  container = win.document.createElement("div");
  root = createRoot(container);
  render();
});

afterEach(async () => {
  act(() => root.unmount());
  await act(async () => {
    await pending;
  });
  pending = undefined;
});
afterAll(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

/** 读取用户流程对应的真实 hook 状态。 */
function state() {
  return JSON.parse(container.textContent ?? "{}");
}

// 超过安全容量的文件应在浏览器直接拒绝，并显示与后端一致的上限。
test("文件选择拒绝92MiB加1字节并提示92MB", () => {
  const file = { name: "over.bin", size: 92 * 1024 * 1024 + 1 } as File;
  act(() =>
    uploads.handleFileInputChange({ target: { files: [file], value: "" } } as unknown as Parameters<
      typeof uploads.handleFileInputChange
    >[0]),
  );
  expect(UploadRequest.requests).toHaveLength(0);
  expect(errors[0]).toContain("92MB");
  expect(state().uploading).toBe(false);
});

// 文件选择入口不传进度回调也必须更新进度，浏览器发送完后等待服务端保存确认。
test("普通文件入口显示传输进度与保存状态", async () => {
  act(() =>
    uploads.handleFileInputChange({
      target: { files: [new File(["hello"], "test.txt")], value: "test.txt" },
    } as unknown as Parameters<typeof uploads.handleFileInputChange>[0]),
  );
  expect(UploadRequest.requests).toHaveLength(1);
  act(() => UploadRequest.requests[0].progress(42));
  expect(state()).toEqual({ uploading: true, progress: { percent: 42, saving: false, targetDir: "" } });
  act(() => UploadRequest.requests[0].progress(100));
  expect(state()).toEqual({ uploading: true, progress: { percent: 100, saving: true, targetDir: "" } });
  expect(completed).toBe(0);
  await act(async () => {
    UploadRequest.requests[0].onload?.();
  });
  expect(state()).toEqual({ uploading: false, progress: null });
  expect(completed).toBe(1);
});

// 多批目录上传按字节加权，等待第一批保存时不能把整次任务显示成 100%。
test("目录分批进度按总字节数累计", async () => {
  const files = [
    new File([new Uint8Array(20 * 1024 * 1024)], "large.bin"),
    new File([new Uint8Array(10 * 1024 * 1024)], "small.bin"),
  ];
  act(() => {
    pending = uploads.uploadFiles(files, undefined, ["folder/large.bin", "folder/small.bin"]);
  });
  act(() => UploadRequest.requests[0].progress(100));
  expect(state().progress).toEqual({ percent: 67, saving: true, targetDir: "" });
  await act(async () => {
    UploadRequest.requests[0].onload?.();
  });
  expect(UploadRequest.requests).toHaveLength(2);
  act(() => UploadRequest.requests[1].progress(50));
  expect(state().progress).toEqual({ percent: 83, saving: false, targetDir: "" });
  await act(async () => {
    UploadRequest.requests[1].onload?.();
    await pending;
  });
  expect(state()).toEqual({ uploading: false, progress: null });
});

// 进度状态记录上传落点，文件树据此把进度条显示在对应分区。
test("上传进度携带落点供分区展示", async () => {
  act(() => {
    pending = uploads.uploadFiles([new File(["hello"], "test.txt")], undefined, undefined, "user");
  });
  expect(state().progress).toEqual({ percent: 0, saving: false, targetDir: "user" });
  act(() => UploadRequest.requests[0].progress(50));
  expect(state().progress).toEqual({ percent: 50, saving: false, targetDir: "user" });
  await act(async () => {
    UploadRequest.requests[0].onload?.();
    await pending;
  });
});

// 切换环境后取消上传，旧连接的进度事件不得污染新环境。
test("切换环境取消上传并忽略旧进度", async () => {
  act(() => {
    pending = uploads.uploadFiles([new File(["hello"], "test.txt")]);
  });
  const old = UploadRequest.requests[0];
  render("other");
  await act(async () => {
    await pending;
  });
  act(() => old.progress(80));
  expect(state()).toEqual({ uploading: false, progress: null });
  expect(completed).toBe(0);
  expect(errors).toHaveLength(0);
});

// 保存失败必须结束进度并显示服务端错误，不得把发送完成误报为成功。
test("保存失败清理进度并报告错误", async () => {
  act(() => {
    pending = uploads.uploadFiles([new File(["hello"], "test.txt")]);
  });
  const request = UploadRequest.requests[0];
  request.status = 503;
  request.responseText = JSON.stringify({ success: false, error: { message: "Remote disconnected" } });
  await act(async () => {
    request.onload?.();
    await pending;
  });
  expect(state()).toEqual({ uploading: false, progress: null });
  expect(errors[0]).toContain("Remote disconnected");
});
