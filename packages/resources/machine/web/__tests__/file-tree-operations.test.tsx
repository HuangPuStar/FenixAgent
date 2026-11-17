import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { parsePathsToTree } from "@fenix/ui-components/components/file-tree-model";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { toast } from "sonner";
import { fsApi } from "../api/fs";
import { useArtifactsFiles } from "../hooks/use-artifacts-files";
import { useFileTreeOperations } from "../hooks/use-file-tree-operations";
import { MACHINE_NS, machineResources } from "../i18n";
import type { WorkspaceFilesChange } from "../lib/workspace-file-operations";

const win = initializeHappyDomWindow(new Window({ url: "http://localhost" }));
const globals = globalThis as Record<string, unknown>;
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "customElements",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originals = new Map(keys.map((key) => [key, globals[key]]));
const i18n = createInstance();
await i18n.init({
  lng: "zh",
  initAsync: false,
  resources: { zh: { [MACHINE_NS]: machineResources.zh } },
  defaultNS: MACHINE_NS,
});
let root: Root;
let api: ReturnType<typeof useFileTreeOperations>;
let changed: WorkspaceFilesChange[];
let selected: string[];
let refreshes: number;
const tree = parsePathsToTree(["docs/a.md", "a.md", "b.md", "c.md", "target/a.md"]);
const renameSpy = spyOn(fsApi, "rename");
const deleteSpy = spyOn(fsApi, "batchDelete");
const successSpy = spyOn(toast, "success").mockImplementation(() => "success");
const errorSpy = spyOn(toast, "error").mockImplementation(() => "error");
const logSpy = spyOn(console, "error").mockImplementation(() => {});
const ok = <T,>(data: T) => ({ success: true as const, data });
function Harness({ envId }: { envId: string }) {
  api = useFileTreeOperations({
    envId,
    enabled: true,
    getTree: () => tree,
    onChanged: (change) => changed.push(change),
    onSelectionChange: (paths) => {
      selected = paths;
    },
    refreshTree: () => {
      refreshes++;
    },
  });
  return null;
}
function render(envId = "env-a") {
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <Harness envId={envId} />
      </I18nextProvider>,
    ),
  );
}
beforeEach(() => {
  for (const key of keys)
    globals[key] = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (win as unknown as Record<string, unknown>)[key];
  globals.window = win;
  const host = win.document.createElement("div");
  win.document.body.append(host);
  root = createRoot(host);
  changed = [];
  selected = [];
  refreshes = 0;
  renameSpy.mockReset();
  deleteSpy.mockReset();
  successSpy.mockClear();
  errorSpy.mockClear();
  logSpy.mockClear();
  renameSpy.mockImplementation(async (_env, oldPath, newPath) => ok({ oldPath, newPath }));
  render();
});

describe("已打开文件与成功操作同步", () => {
  // 切换面板会卸载树但保留预览，先前已确认成功的移动不能随在途批次丢失。
  test("批量移动中途卸载仍保留成功项目的预览路径", async () => {
    let files: ReturnType<typeof useArtifactsFiles>;
    const pending = Promise.withResolvers<ReturnType<typeof ok<{ oldPath: string; newPath: string }>>>();
    renameSpy.mockImplementation(async (_env, oldPath, newPath) =>
      oldPath === "c.md" ? pending.promise : ok({ oldPath, newPath }),
    );
    function MovingTree({ onChanged }: { onChanged: (change: WorkspaceFilesChange) => void }) {
      api = useFileTreeOperations({
        envId: "env-a",
        enabled: true,
        getTree: () => tree,
        onChanged,
        onSelectionChange: () => {},
        refreshTree: () => {},
      });
      return null;
    }
    function PreviewHarness({ show }: { show: boolean }) {
      files = useArtifactsFiles({ envId: "env-a", isFilesMode: show, onEnterFilesMode: () => {} });
      return show ? <MovingTree onChanged={files.handleFilesChanged} /> : null;
    }
    const renderPreview = (show: boolean) =>
      act(() =>
        root.render(
          <I18nextProvider i18n={i18n}>
            <PreviewHarness show={show} />
          </I18nextProvider>,
        ),
      );
    renderPreview(true);
    act(() => files.openFile("b.md"));
    let batch: Promise<boolean>;
    await act(async () => {
      batch = api.moveToDirectory(["b.md", "c.md"], "target");
      await Promise.resolve();
    });
    expect(renameSpy).toHaveBeenCalledTimes(2);
    renderPreview(false);
    await act(async () => {
      pending.resolve(ok({ oldPath: "c.md", newPath: "target/c.md" }));
      await batch;
    });
    expect(files.openFiles).toEqual(["target/b.md"]);
    expect(files.activeFile).toBe("target/b.md");
    expect(renameSpy.mock.calls[1]?.[3]?.aborted).toBe(true);
  });

  // 文件夹移动更新所有后代 tab，删除只关闭已成功删除的范围。
  test("移动重写预览路径，删除清理对应 tab", () => {
    let files: ReturnType<typeof useArtifactsFiles>;
    function PreviewHarness() {
      files = useArtifactsFiles({ envId: "env-a", isFilesMode: true, onEnterFilesMode: () => {} });
      return null;
    }
    act(() => root.render(<PreviewHarness />));
    act(() => {
      files.openFile("docs/a.md");
      files.openFile("docs/b.md");
    });
    act(() => files.handleFilesChanged({ moved: [{ oldPath: "docs", newPath: "target/docs" }], deleted: [] }));
    expect(files.openFiles).toEqual(["target/docs/b.md", "target/docs/a.md"]);
    expect(files.activeFile).toBe("target/docs/b.md");
    act(() => files.handleFilesChanged({ moved: [], deleted: ["target/docs/b.md"] }));
    expect(files.openFiles).toEqual(["target/docs/a.md"]);
    expect(files.activeFile).toBeNull();
  });

  // 环境改变后不能把旧环境的路径带入新环境预览。
  test("切换环境清理旧文件状态", () => {
    let files: ReturnType<typeof useArtifactsFiles>;
    function PreviewHarness({ envId }: { envId: string }) {
      files = useArtifactsFiles({ envId, isFilesMode: true, onEnterFilesMode: () => {} });
      return null;
    }
    act(() => root.render(<PreviewHarness envId="env-a" />));
    act(() => files.openFile("docs/a.md"));
    act(() => root.render(<PreviewHarness envId="env-b" />));
    expect(files.openFiles).toEqual([]);
    expect(files.activeFile).toBeNull();
  });
});
afterEach(() => {
  act(() => root.unmount());
  win.document.body.innerHTML = "";
});
afterAll(() => {
  renameSpy.mockRestore();
  deleteSpy.mockRestore();
  successSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
  for (const [key, value] of originals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

describe("文件写操作编排", () => {
  // 新建入口必须发出仅创建意图，过期树中的同名文件不能被空内容覆盖。
  test("新建文件遇到服务端同名冲突保留原内容并反馈失败", async () => {
    let content = "original";
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { content: string; createOnly?: boolean };
      if (body.createOnly)
        return new Response(JSON.stringify({ error: { code: "path_conflict", message: "exists" } }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      content = body.content;
      return new Response(JSON.stringify(ok({ name: "hidden.md", path: "hidden.md", size: 0 })));
    });
    try {
      let success = true;
      await act(async () => {
        success = await api.createPath("hidden.md", false);
      });
      expect(success).toBe(false);
      expect(content).toBe("original");
      expect(errorSpy.mock.calls[0]?.[0]).toBe(machineResources.zh.fileTree.pathConflict);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // 请求删除只准备确认范围，取消和打开菜单均不能触发实际删除。
  test("确认之前不调用删除接口，父子路径只提交一次", async () => {
    act(() => api.requestDelete(["docs", "docs/a.md"]));
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(api.deleteConfirm?.paths).toEqual(["docs"]);
    act(() => api.closeDelete());
    expect(api.deleteConfirm).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
    deleteSpy.mockResolvedValue(ok({ deleted: ["docs"], failed: [] }));
    act(() => api.requestDelete(["docs", "docs/a.md"]));
    await act(async () => {
      await api.confirmDelete();
    });
    expect(deleteSpy.mock.calls[0]?.[1]).toEqual(["docs"]);
    expect(changed).toEqual([{ moved: [], deleted: ["docs"] }]);
    expect(api.deleteConfirm).toBeNull();
  });

  // HTTP 成功不代表整批删除成功；成功项同步预览，失败项保留供重试。
  test("部分删除刷新树并只保留失败项", async () => {
    deleteSpy.mockResolvedValue(ok({ deleted: ["a.md"], failed: [{ path: "b.md", error: "被占用" }] }));
    act(() => api.requestDelete(["a.md", "b.md"]));
    await act(async () => {
      await api.confirmDelete();
    });
    expect(changed).toEqual([{ moved: [], deleted: ["a.md"] }]);
    expect(selected).toEqual(["b.md"]);
    expect(api.deleteConfirm?.paths).toEqual(["b.md"]);
    expect(refreshes).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("b.md");
  });

  // 同名冲突和单项失败不能阻止独立的其他文件移动。
  test("移动跳过同名并继续独立项目，报告每个失败", async () => {
    renameSpy.mockImplementation(async (_env, oldPath, newPath) => {
      if (oldPath === "b.md") throw new Error("被占用");
      return ok({ oldPath, newPath });
    });
    await act(async () => {
      await api.moveToDirectory(["a.md", "b.md", "c.md"], "target");
    });
    expect(renameSpy.mock.calls.map((call) => call[1])).toEqual(["b.md", "c.md"]);
    expect(changed).toEqual([{ moved: [{ oldPath: "c.md", newPath: "target/c.md" }], deleted: [] }]);
    expect(selected).toEqual(["a.md", "b.md"]);
    expect(refreshes).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("a.md");
    expect(errorSpy.mock.calls[0]?.[0]).toContain("b.md");
  });

  // 同步在途锁防止 React 尚未重渲染时收到第二个写操作。
  test("阻止重复提交，环境切换终止旧批次并忽略旧结果", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof ok<{ oldPath: string; newPath: string }>>>();
    renameSpy.mockReturnValue(pending.promise);
    let first: Promise<boolean>;
    act(() => {
      first = api.moveToDirectory(["b.md", "c.md"], "target");
    });
    await act(async () => {
      await api.moveToDirectory(["a.md"], "user");
    });
    expect(renameSpy).toHaveBeenCalledTimes(1);
    render("env-b");
    await act(async () => {
      pending.resolve(ok({ oldPath: "b.md", newPath: "target/b.md" }));
      await first;
    });
    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(changed).toEqual([]);
    expect(refreshes).toBe(0);
    expect(api.busy).toBe(false);
  });
});
