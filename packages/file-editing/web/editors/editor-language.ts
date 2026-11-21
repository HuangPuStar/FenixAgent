/**
 * CodeMirror 语言映射：按 workspace 相对路径推断编辑器语言，语言包按需动态 import。
 *
 * 只有真正进入编辑模式时才加载语言包；这里只持映射与加载器，不 import React。
 */
import type { LanguageSupport } from "@codemirror/language";

/** 编辑器语言标识；`plaintext` 不加载语言包（无高亮）。 */
export type EditorLanguageId =
  | "markdown"
  | "javascript"
  | "typescript"
  | "json"
  | "html"
  | "css"
  | "python"
  | "sql"
  | "yaml"
  | "plaintext";

/** 按 workspace 相对路径（按扩展名）推断编辑器语言；未知扩展名回落 plaintext。 */
export function getEditorLanguage(path: string): EditorLanguageId {
  const fileName = path.split("/").pop() ?? path;
  const dotIndex = fileName.lastIndexOf(".");
  const ext = dotIndex === -1 ? "" : fileName.slice(dotIndex + 1).toLowerCase();
  switch (ext) {
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "ts":
    case "tsx":
      return "typescript";
    case "json":
    case "jsonc":
      return "json";
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return "html";
    case "css":
    case "scss":
    case "less":
    case "sass":
      return "css";
    case "py":
      return "python";
    case "sql":
      return "sql";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "plaintext";
  }
}

/**
 * `.md` 走富文本编辑器（markdown-editor.tsx）的判定。
 * `.mdx` 的 JSX 块没有富文本语义，使用 CodeMirror 保留原文。
 */
export function isMarkdownRichTextFile(path: string): boolean {
  const fileName = path.split("/").pop() ?? path;
  const dotIndex = fileName.lastIndexOf(".");
  const ext = dotIndex === -1 ? "" : fileName.slice(dotIndex + 1).toLowerCase();
  return ext === "md" || ext === "markdown";
}

/** 语言包加载器缓存：同一会话内重复进入编辑模式不再二次 import。 */
const languageLoaders = new Map<EditorLanguageId, Promise<LanguageSupport | null>>();

/**
 * 动态加载语言扩展。返回 null 表示 plaintext（不加载语言包）。
 * 必须是稳定输出（同一语言返回同一 Promise），否则编辑器重建会反复 import。
 */
export function loadEditorLanguage(id: EditorLanguageId): Promise<LanguageSupport | null> {
  const cached = languageLoaders.get(id);
  if (cached) return cached;
  const loader = (async (): Promise<LanguageSupport | null> => {
    switch (id) {
      case "markdown":
        return (await import("@codemirror/lang-markdown")).markdown();
      case "javascript":
        return (await import("@codemirror/lang-javascript")).javascript();
      case "typescript":
        return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
      case "json":
        return (await import("@codemirror/lang-json")).json();
      case "html":
        return (await import("@codemirror/lang-html")).html();
      case "css":
        return (await import("@codemirror/lang-css")).css();
      case "python":
        return (await import("@codemirror/lang-python")).python();
      case "sql":
        return (await import("@codemirror/lang-sql")).sql();
      case "yaml":
        return (await import("@codemirror/lang-yaml")).yaml();
      case "plaintext":
        return null;
    }
  })();
  void loader.catch(() => {
    languageLoaders.delete(id);
  });
  languageLoaders.set(id, loader);
  return loader;
}
