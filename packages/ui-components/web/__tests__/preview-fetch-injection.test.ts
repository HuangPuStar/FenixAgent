// web/__tests__/preview-fetch-injection.test.ts
// 预览链路的取数注入守卫（前端规范 §5.8「禁止在组件中裸调 fetch」/ §6.2）。
//
// 背景：预览 URL（`/web/environments/<envId>/fs/<path>?preview=true`）指向后端的文件代理路由，取数属
// 后端调用。本包是纯展示包、依赖矩阵不允许依赖 `@fenix/web-runtime`，因此取数函数只能由宿主注入
// （`apps/web/src/api/fs.ts` 的 `readPreviewSource`）。三条不变量在本文件里被钉住：
//   1. `loadByteAccuratePreviewSource` 用的是注入的取数函数，不碰全局 `fetch`；
//   2. `htmlPreviewPlugin` 的「源码」页正文同样来自注入的取数函数（同一个 `src`，同一份字节）；
//   3. 源码里不存在全局 `fetch` 兜底形态（默认参数 / 裸调用）——兜底会让组件重新直连后端。
//
// happy-dom：`viewport` 刻意是游离节点（不挂进 document），iframe 因此不会真的去加载 URL，
// 用例只断言插件对取数函数的调用与源码页内容。

import { describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { htmlPreviewPlugin } from "../components/preview/html-plugin";
import { loadByteAccuratePreviewSource, type PreviewFetch } from "../components/preview/preview-source";

const win = initializeHappyDomWindow(new Window());
const globalScope = globalThis as Record<string, unknown>;
globalScope.window = win;
globalScope.document = win.document;

/** 记录调用参数的取数函数替身；返回值按用例需要给出。 */
function createPreviewFetch(response: () => Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchPreview: PreviewFetch = (url, init) => {
    calls.push({ url, init });
    return response();
  };
  return { calls, fetchPreview };
}

describe("预览取数由宿主注入（包内无全局 fetch 兜底）", () => {
  // 取数函数是传播途中唯一能带上宿主鉴权/代理策略的位置：文本类预览取字节必须走它，
  // 而不是回过头去用全局 fetch（那会让组件直连后端，§5.8）。
  test("文本预览取字节走注入的取数函数", async () => {
    const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    // 全局 fetch 换成失败桩：一旦实现回退到它，本用例立刻失败
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: () => Promise.reject(new Error("组件不得直取全局 fetch")),
    });
    const { calls, fetchPreview } = createPreviewFetch(async () => new Response("内容"));

    const blob = await loadByteAccuratePreviewSource("/web/environments/e1/fs/user/a.md?preview=true", fetchPreview);

    expect(await blob.text()).toBe("内容");
    expect(calls.map((call) => call.url)).toEqual(["/web/environments/e1/fs/user/a.md?preview=true"]);
    if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
  });

  // HTML 预览的「源码」页与文本预览取的是同一份文件，必须共用一个取数入口：
  // 插件在 DOM 里跑、拿不到 React 上下文，注入是它唯一的取数通道。
  test("HTML 预览的源码页正文来自注入的取数函数", async () => {
    const html = "<p>hello</p>";
    const { calls, fetchPreview } = createPreviewFetch(async () => new Response(html));
    const viewport = win.document.createElement("div");
    let loading = false;
    const errors: string[] = [];

    const instance = htmlPreviewPlugin(fetchPreview).render({
      viewport,
      file: { name: "a.html", url: "data:text/html,<p>hello</p>", extension: "html" },
      setLoading: (value: boolean) => {
        loading = value;
      },
      setError: (message: string) => {
        errors.push(message);
      },
    } as unknown as Parameters<ReturnType<typeof htmlPreviewPlugin>["render"]>[0]);

    // 源码正文是异步取的：等取数链路的微任务跑完（插件自身不 await）
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls.map((call) => call.url)).toEqual(["data:text/html,<p>hello</p>"]);
    expect(errors).toEqual([]);
    expect(loading).toBe(true);
    // 源码页容器是插件里唯一带类名的节点，正文必须是取数函数返回的那份字节
    expect(viewport.querySelector(".fenix-html-source-view")?.textContent).toBe(html);

    instance.destroy();
  });

  // 静态钉住「没有兜底」：默认参数或裸调用都会让包在宿主忘记注入时静默直连后端。
  // 断言前先把注释剥掉——文件头的取舍说明本来就要引用「旧实现直取全局 fetch」这个形态。
  test("预览模块的源码里不存在全局 fetch 兜底形态", async () => {
    const files = [
      "../components/preview/preview-source.ts",
      "../components/preview/html-plugin.ts",
      "../components/preview/FileViewerPreview.tsx",
    ];
    for (const file of files) {
      const source = stripComments(await Bun.file(new URL(file, import.meta.url)).text());
      expect(source).not.toContain("= fetch");
      expect(source).not.toContain(", fetch,");
      expect(source).not.toMatch(/\bfetch\s*\(/);
    }
  });
});

/** 剥掉块注释与行注释：静态断言只针对生效代码，说明文字不参与判定。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
