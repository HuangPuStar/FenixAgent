import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $node, $remark } from "@milkdown/kit/utils";
import remarkFrontmatter from "remark-frontmatter";

/** 将 YAML 保留为可编辑的独立节点，避免被正文解析或重新格式化。 */
export function createMarkdownFrontmatterPlugins(label: string): MilkdownPlugin[] {
  const syntax = $remark("markdown-frontmatter", () => remarkFrontmatter, ["yaml"]);
  const schema = $node("yaml", () => ({
    content: "text*",
    group: "block",
    marks: "",
    code: true,
    defining: true,
    isolating: true,
    parseDOM: [
      {
        tag: 'div[data-markdown-frontmatter="yaml"]',
        contentElement: "pre",
        preserveWhitespace: "full",
      },
    ],
    toDOM: () => [
      "div",
      {
        "data-markdown-frontmatter": "yaml",
        "aria-label": label,
        class: "not-prose my-4 overflow-hidden rounded-lg border border-border bg-surface-2",
      },
      [
        "div",
        {
          contenteditable: "false",
          class: "border-b border-border bg-surface-1 px-4! py-2! text-xs font-medium text-text-muted",
        },
        label,
      ],
      ["pre", { class: "m-0 whitespace-pre-wrap break-words p-4! font-mono text-xs leading-relaxed" }, 0],
    ],
    parseMarkdown: {
      match: (node) => node.type === "yaml",
      runner: (state, node, type) => {
        state.openNode(type);
        if (typeof node.value === "string" && node.value.length > 0) state.addText(node.value);
        state.closeNode();
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === "yaml",
      runner: (state, node) => {
        state.addNode("yaml", undefined, node.textContent);
      },
    },
  }));
  return [...syntax, schema];
}

/** Keep untouched metadata byte-for-byte even when the Markdown serializer normalizes line endings. */
export function preserveRawFrontmatter(source: string, serialized: string): string {
  const pattern = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
  const original = pattern.exec(source);
  const next = pattern.exec(serialized);
  if (!original || !next || original[1]?.replaceAll("\r\n", "\n") !== next[1]?.replaceAll("\r\n", "\n"))
    return serialized;
  return original[0] + serialized.slice(next[0].length);
}
