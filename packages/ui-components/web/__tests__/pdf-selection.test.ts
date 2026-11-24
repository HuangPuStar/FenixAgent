import { expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { readPdfTextSelection } from "../components/preview/pdf-selection";

const win = initializeHappyDomWindow(new Window());
const location = (first: number, last: number) => (first === last ? `Page ${first}` : `Pages ${first}–${last}`);
function fixture() {
  const root = win.document.createElement("div");
  root.dataset.pdfPreview = "true";
  root.innerHTML =
    '<div data-page-number="1"><div class="textLayer"><span>中文第一页</span></div></div><div data-page-number="2"><div class="textLayer"><span>Second page</span></div></div><div role="alert">Failed to render</div>';
  win.document.body.replaceChildren(root);
  const spans = [...root.querySelectorAll("span")];
  const range = win.document.createRange();
  return {
    root,
    spans,
    range,
    select() {
      const selection = win.document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    },
    event: (target: Element) => ({ target, clientX: 0, clientY: 0, button: 0 }) as unknown as MouseEvent,
  };
}

// 单页正文必须带上从零基页码换算的一基页码，不能只引用无来源的文字。
test("quotes PDF text with its one-based page number", () => {
  const f = fixture();
  f.range.selectNodeContents(f.spans[0]!);
  f.select();
  expect(readPdfTextSelection(f.event(f.spans[0] as unknown as Element), location)).toEqual({
    text: "中文第一页",
    location: "Page 1",
  });
});

// 跨页选择保留全部原文，并用页码范围标识来源。
test("quotes PDF selections across two pages", () => {
  const f = fixture();
  f.range.setStart(f.spans[0]!.firstChild!, 0);
  f.range.setEnd(f.spans[1]!.firstChild!, 11);
  f.select();
  expect(readPdfTextSelection(f.event(f.spans[0] as unknown as Element), location)?.location).toBe("Pages 1–2");
});

// 错误、加载状态和非文字层不是文件内容，不能成为引用。
test("does not quote PDF status text outside the text layer", () => {
  const f = fixture(),
    status = f.root.querySelector('[role="alert"]')!;
  f.range.selectNodeContents(status);
  f.select();
  expect(readPdfTextSelection(f.event(status as unknown as Element), location)).toBeNull();
});

// 从正文拖到查看器外部的选区不能夹带聊天或其他文件的文本。
test("rejects PDF selections that leave the current document", () => {
  const f = fixture(),
    outside = win.document.createElement("p");
  outside.textContent = "Other file";
  win.document.body.append(outside);
  f.range.setStart(f.spans[0]!.firstChild!, 0);
  f.range.setEnd(outside.firstChild!, 5);
  f.select();
  expect(readPdfTextSelection(f.event(f.spans[0] as unknown as Element), location)).toBeNull();
});

// 从上一页末尾开始的 Range 没有选中上一页字符，页码不能多算一页。
test("ignores an empty start boundary on the previous PDF page", () => {
  const f = fixture();
  f.range.setStart(f.spans[0]!.firstChild!, f.spans[0]!.textContent!.length);
  f.range.setEnd(f.spans[1]!.firstChild!, 6);
  f.select();
  expect(readPdfTextSelection(f.event(f.spans[1] as unknown as Element), location)?.location).toBe("Page 2");
});

// 只碰到下一页开头、没有选中下一页字符时，不扩大引用页码范围。
test("ignores an empty end boundary on the following PDF page", () => {
  const f = fixture();
  f.range.setStart(f.spans[0]!.firstChild!, 0);
  f.range.setEnd(f.spans[1]!.firstChild!, 0);
  f.select();
  expect(readPdfTextSelection(f.event(f.spans[0] as unknown as Element), location)?.location).toBe("Page 1");
});
