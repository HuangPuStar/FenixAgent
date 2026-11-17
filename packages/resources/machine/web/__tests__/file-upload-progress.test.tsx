import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { parsePathsToTree } from "@fenix/ui-components/components/file-tree-model";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { useFileMutationLock } from "../hooks/use-file-mutation-lock";
import { useFileTreeOperations } from "../hooks/use-file-tree-operations";
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
  aborted = false;
  open() {}
  setRequestHeader() {}
  send() {
    UploadRequest.requests.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(percent: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded: percent, total: 100 });
  }
}

let root: Root;
let container: HTMLElement;
let uploads: ReturnType<typeof useFileUploads>;
let operations: ReturnType<typeof useFileTreeOperations>;
const tree = parsePathsToTree(["docs/a.md", "target/"]);
let completed = 0;
const errors: string[] = [];
let pending: Promise<void> | undefined;

function Harness({ envId }: { envId: string }) {
  const mutationLock = useFileMutationLock(envId);
  uploads = useFileUploads({
    envId,
    mutationLock,
    onUploaded: () => {
      completed++;
    },
    onError: (message) => errors.push(message),
  });
  operations = useFileTreeOperations({
    mutationLock,
    envId,
    enabled: true,
    getTree: () => tree,
    onChanged: () => {},
    onSelectionChange: () => {},
    refreshTree: () => {},
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

// 上传中的目录不能同时被移动或删除，写锁状态须同步驱动所有入口。
test("上传期间同一事件内阻止其他文件写入", async () => {
  let renamed: Promise<boolean> | undefined;
  act(() => operations.requestDelete(["docs"]));
  act(() => {
    pending = uploads.uploadFiles([new File(["hello"], "test.txt")]);
    renamed = operations.renamePath("docs", "moved");
  });
  expect(operations.busy).toBe(true);
  await act(async () => {
    expect(await renamed).toBe(false);
    expect(await operations.createPath("new.txt", false)).toBe(false);
    expect(await operations.createPath("folder", true)).toBe(false);
    expect(await operations.moveToDirectory(["docs"], "target")).toBe(false);
    expect(await operations.confirmDelete()).toBe(false);
  });
  expect(operations.deleteConfirm?.paths).toEqual(["docs"]);
  await act(async () => {
    UploadRequest.requests[0].onload?.();
    await pending;
  });
  expect(operations.busy).toBe(false);
});

// 文件写操作先占锁时，同一事件中的上传不能进入网络或抢占已有操作。
test("树写入期间同步拒绝上传，完成后重新允许上传", async () => {
  const response = Promise.withResolvers<Response>();
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() => response.promise);
  let writing: Promise<boolean> | undefined;
  try {
    act(() => {
      writing = operations.renamePath("docs", "moved");
      pending = uploads.uploadFiles([new File(["hello"], "test.txt")]);
    });
    expect(UploadRequest.requests).toHaveLength(0);
    expect(operations.busy).toBe(true);
    await act(async () => {
      response.resolve(
        new Response(JSON.stringify({ success: true, data: { oldPath: "docs", newPath: "moved" } }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(await writing).toBe(true);
      await pending;
    });
    act(() => {
      pending = uploads.uploadFiles([new File(["hello"], "test.txt")]);
    });
    expect(UploadRequest.requests).toHaveLength(1);
    await act(async () => {
      UploadRequest.requests[0].onload?.();
      await pending;
    });
    expect(operations.busy).toBe(false);
  } finally {
    fetchSpy.mockRestore();
  }
});

// 旧上传的 finally 晚于新环境任务执行，不能释放新任务的锁或清空其进度。
test("环境切换后旧上传清理不释放新任务锁", async () => {
  act(() => {
    pending = uploads.uploadFiles([new File(["old"], "old.txt")]);
  });
  const oldPending = pending;
  const oldRequest = UploadRequest.requests[0];
  render("other");
  act(() => {
    pending = uploads.uploadFiles([new File(["new"], "new.txt")]);
  });
  await act(async () => {
    await oldPending;
  });
  act(() => oldRequest.progress(80));
  expect(operations.busy).toBe(true);
  expect(state().progress.percent).toBe(0);
  await act(async () => {
    expect(await operations.createPath("blocked", false)).toBe(false);
  });
  await act(async () => {
    UploadRequest.requests[1].onload?.();
    await pending;
  });
  expect(operations.busy).toBe(false);
  expect(completed).toBe(1);
});

// 读取外部拖入文件本身是异步步骤，读取期间也必须保留目标目录的写锁。
test("外部拖入读取期间持锁并在上传完成后释放", async () => {
  let accept: ((file: File) => void) | undefined;
  const transfer = {
    items: [
      {
        kind: "file",
        getAsFile: () => null,
        webkitGetAsEntry: () => ({
          name: "test.txt",
          isFile: true,
          isDirectory: false,
          file: (success: (file: File) => void) => {
            accept = success;
          },
        }),
      },
    ],
    files: [],
  } as unknown as DataTransfer;
  act(() => {
    pending = uploads.uploadDroppedFiles(transfer, "docs");
  });
  expect(operations.busy).toBe(true);
  expect(UploadRequest.requests).toHaveLength(0);
  await act(async () => {
    expect(await operations.renamePath("docs", "moved")).toBe(false);
  });
  await act(async () => {
    accept?.(new File(["hello"], "test.txt"));
  });
  expect(UploadRequest.requests).toHaveLength(1);
  expect(state().progress.targetDir).toBe("docs");
  await act(async () => {
    UploadRequest.requests[0].onload?.();
    await pending;
  });
  expect(operations.busy).toBe(false);
});

// 卸载必须取消上传，旧事件和保留的回调不得再启动网络请求。
test("卸载终止上传并拒绝旧回调继续写入", async () => {
  act(() => {
    pending = uploads.uploadFiles([new File(["old"], "old.txt")]);
  });
  const retained = uploads;
  const request = UploadRequest.requests[0];
  act(() => root.render(null));
  await act(async () => {
    await pending;
  });
  expect(request.aborted).toBe(true);
  await act(async () => {
    request.onload?.();
    await retained.uploadFiles([new File(["late"], "late.txt")]);
  });
  expect(UploadRequest.requests).toHaveLength(1);
  expect(completed).toBe(0);
  render();
  act(() => {
    pending = uploads.uploadFiles([new File(["new"], "new.txt")]);
  });
  expect(operations.busy).toBe(true);
  await act(async () => {
    UploadRequest.requests[1].onload?.();
    await pending;
  });
  expect(operations.busy).toBe(false);
});

// 超过安全容量的文件应在浏览器直接拒绝，并显示与后端一致的上限。
test("文件选择拒绝92MiB加1字节并提示92MB", async () => {
  const file = { name: "over.bin", size: 92 * 1024 * 1024 + 1 } as File;
  await act(async () =>
    uploads.handleFileInputChange({ target: { files: [file], value: "" } } as unknown as Parameters<
      typeof uploads.handleFileInputChange
    >[0]),
  );
  expect(UploadRequest.requests).toHaveLength(0);
  expect(errors[0]).toContain("92MB");
  expect(state().uploading).toBe(false);
  expect(operations.busy).toBe(false);
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
  expect(operations.busy).toBe(false);
  act(() => {
    pending = uploads.uploadFiles([new File(["retry"], "retry.txt")]);
  });
  expect(UploadRequest.requests).toHaveLength(2);
  await act(async () => {
    UploadRequest.requests[1].onload?.();
    await pending;
  });
  expect(operations.busy).toBe(false);
});
