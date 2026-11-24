import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { defaultValueCtx, Editor, editorViewCtx, parserCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { Window } from "happy-dom";
import { createMarkdownFrontmatterPlugins } from "../editors/markdown-frontmatter";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;
const DOM_GLOBALS = [
  "CustomEvent",
  "DOMParser",
  "Element",
  "Event",
  "HTMLElement",
  "MutationObserver",
  "Node",
  "Text",
  "customElements",
] as const;
const BOUND_GLOBALS = [
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "getComputedStyle",
  "getSelection",
  "requestAnimationFrame",
  "cancelAnimationFrame",
] as const;
const TRACKED_GLOBALS = [...DOM_GLOBALS, ...BOUND_GLOBALS, "window", "document", "navigator"] as const;
const originalGlobals = new Map(TRACKED_GLOBALS.map((key) => [key, globals[key]]));
const YAML =
  '# 保留说明\nname: workstep-split\ndescription: |\n  第一行描述\n  第二行描述\ntags:\n  - 工步\n  - 质检\nmetadata:\n  owner: "研发"';
const HEADER = `---\n${YAML}\n---\n`;
let host: HTMLElement;
let editor: Editor | null = null;

beforeEach(() => {
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  const windowGlobals = win as unknown as Record<string, unknown>;
  for (const key of DOM_GLOBALS) globals[key] = windowGlobals[key];
  for (const key of BOUND_GLOBALS) {
    const value = windowGlobals[key];
    if (typeof value === "function") globals[key] = value.bind(win);
  }
  host = win.document.createElement("div") as unknown as HTMLElement;
  document.body.append(host);
});

afterEach(async () => {
  await editor?.destroy();
  editor = null;
  host.remove();
  await win.happyDOM.abort();
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

async function openDocument(markdown: string) {
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(createMarkdownFrontmatterPlugins("YAML 元数据"))
    .create();
  return editor.action((ctx) => ({
    view: ctx.get(editorViewCtx),
    parse: ctx.get(parserCtx),
    serialize: ctx.get(serializerCtx),
  }));
}

describe("Markdown YAML 元数据富文本扩展", () => {
  // 文件头必须成为独立节点，正文标题、粗体与列表仍保留富文本语义。
  test("Skill 文件头独立展示，注释、嵌套字段和多行值完整往返", async () => {
    const { view, serialize } = await openDocument(`${HEADER}\n# 使用方法\n\n**核对工步**\n\n- 输出表格\n`);
    expect(view.state.doc.firstChild?.type.name).toBe("yaml");
    expect(view.state.doc.firstChild?.textContent).toBe(YAML);
    expect(view.state.doc.child(1).type.name).toBe("heading");
    expect(host.querySelector('[data-markdown-frontmatter="yaml"] pre')?.textContent).toBe(YAML);
    expect(serialize(view.state.doc).startsWith(HEADER)).toBe(true);
    expect(serialize(view.state.doc)).toContain("**核对工步**");
    expect(view.state.doc.lastChild?.type.name).toBe("bullet_list");
  });

  // 正文编辑不能让未编辑的元数据经历 YAML 重排或丢失。
  test("修改正文后保存仍保留原始文件头", async () => {
    const { view, serialize } = await openDocument(`${HEADER}\n原有工步\n`);
    view.dispatch(view.state.tr.insertText("，补充检验", view.state.doc.content.size - 1));
    const saved = serialize(view.state.doc);
    expect(saved.startsWith(HEADER)).toBe(true);
    expect(saved).toContain("原有工步，补充检验");
  });

  // 元数据可以在同一个富文本编辑器中编辑，保存后仍是标准 YAML 文件头。
  test("修改元数据后重新打开保留新值及正文富文本", async () => {
    const { view, parse, serialize } = await openDocument(`${HEADER}\n# 使用方法\n`);
    const from = 1 + YAML.indexOf("workstep-split");
    view.dispatch(view.state.tr.insertText("workstep-review", from, from + "workstep-split".length));
    const saved = serialize(view.state.doc);
    const reopened = parse(saved);
    expect(reopened.firstChild?.type.name).toBe("yaml");
    expect(reopened.firstChild?.textContent).toBe(YAML.replace("workstep-split", "workstep-review"));
    expect(reopened.child(1).type.name).toBe("heading");
    expect(serialize(reopened)).toBe(saved);
  });

  // 只有元数据、空元数据和 Windows 换行都不能使文件头退化为正文。
  test("空文件头、仅文件头及 CRLF 文件均可重新打开", async () => {
    const { parse, serialize } = await openDocument("---\n---\n");
    for (const source of ["---\n---\n", HEADER, `${HEADER.replaceAll("\n", "\r\n")}\r\n正文\r\n`]) {
      const document = parse(source);
      expect(document.firstChild?.type.name).toBe("yaml");
      const reopened = parse(serialize(document));
      expect(reopened.firstChild?.textContent).toBe(document.firstChild?.textContent);
    }
  });

  // 普通文档的分隔线不是文件元数据，扩展不能改变其正文语义。
  test("正文分隔线与未闭合分隔线仍按普通 Markdown 处理", async () => {
    const { view, parse } = await openDocument("# 标题\n\n---\n\n正文\n");
    expect(view.state.doc.firstChild?.type.name).toBe("heading");
    expect(view.state.doc.child(1).type.name).toBe("hr");
    expect(parse("---\n\n未闭合\n").firstChild?.type.name).toBe("hr");
  });

  // 元数据可能包含任意外部文本，显示时必须保留文本而不解析 HTML。
  test("元数据中的 HTML 按文本展示且保存不丢失", async () => {
    const yaml = 'description: "<img src=x onerror=alert(1)>"';
    const { view, serialize } = await openDocument(`---\n${yaml}\n---\n\n正文\n`);
    expect(host.querySelector('[data-markdown-frontmatter="yaml"] pre')?.textContent).toBe(yaml);
    expect(host.querySelector("img")).toBeNull();
    expect(serialize(view.state.doc).startsWith(`---\n${yaml}\n---\n`)).toBe(true);
  });
});
