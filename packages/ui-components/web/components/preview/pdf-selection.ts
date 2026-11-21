import { readDomTextSelection, type TextSelection } from "../text-selection";

/** Read a selected PDF text layer with reliable one-based page provenance. */
export function readPdfTextSelection(
  event: MouseEvent,
  formatLocation: (firstPage: number, lastPage: number) => string,
): TextSelection | null {
  const target = event.target as Element | null;
  if (typeof target?.closest !== "function") return null;
  const root = target.closest<HTMLElement>("[data-pdf-preview]");
  if (!root) return null;
  const value = readDomTextSelection(root, event);
  if (!value) return null;
  const range = root.ownerDocument.getSelection()?.getRangeAt(0);
  if (!range) return null;
  const pageAt = (node: Node) => {
    const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const layer = element?.closest(".textLayer");
    const page = layer?.closest("[data-page-number]");
    if (!page || !root.contains(page)) return null;
    const number = Number(page.getAttribute("data-page-number"));
    return Number.isInteger(number) && number >= 1 ? number : null;
  };
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  let first: number | null = null;
  let last: number | null = null;
  // A boundary at the end of a preceding page contains no selected characters from that page.
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    const text = node.textContent ?? "";
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    if (!text.slice(start, end).trim()) continue;
    const page = pageAt(node);
    if (page === null) return null;
    first ??= page;
    last = page;
  }
  if (first === null || last === null || first > last) return null;
  return { ...value, location: formatLocation(first, last) };
}
