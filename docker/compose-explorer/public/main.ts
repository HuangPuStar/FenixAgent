/**
 * 应用装配：状态、事件与三个区域（工具条 / 图 / 面板）的渲染调度。
 *
 * 数据流单向：`state → render()`。任何交互只改 state 再调用 render，避免图与面板各自维护一份状态。
 * 点编排节点时面板直接切到「文件」并打开它的 compose 文件——这是本工具的主要用法。
 */

import { fetchFile, fetchFiles, fetchTopology, refreshTopology } from "./api.ts";
import { createGraph } from "./graph.ts";
import { buildGraph, DEFAULT_FILTERS, type Filters } from "./model.ts";
import {
  type PanelContext,
  type PanelHandlers,
  renderDetailTab,
  renderFilesTab,
  renderWarningsTab,
  revealLine,
} from "./panel.ts";
import type { EdgeKind, FileContent, FileSummary, Selection, Topology } from "./types.ts";

type TabName = "detail" | "files" | "warnings";

const state = {
  topology: null as Topology | null,
  filesByGroup: new Map<string, FileSummary[]>(),
  fileCache: new Map<string, FileContent>(),
  selection: null as Selection,
  filters: { ...DEFAULT_FILTERS, kinds: { ...DEFAULT_FILTERS.kinds } } as Filters,
  tab: "detail" as TabName,
  files: { docId: null as string | null, fileId: null as string | null, highlight: null as [number, number] | null },
};

const dom = {
  svg: document.querySelector<SVGSVGElement>("#graph")!,
  tooltip: document.querySelector<HTMLElement>("#tooltip")!,
  summary: document.querySelector<HTMLElement>("#summary")!,
  legend: document.querySelector<HTMLElement>("#legend")!,
  search: document.querySelector<HTMLInputElement>("#search")!,
  detail: document.querySelector<HTMLElement>("#tab-detail")!,
  files: document.querySelector<HTMLElement>("#tab-files")!,
  warnings: document.querySelector<HTMLElement>("#tab-warnings")!,
  warningCount: document.querySelector<HTMLElement>("#warning-count")!,
  panel: document.querySelector<HTMLElement>(".panel")!,
  splitter: document.querySelector<HTMLElement>("#splitter")!,
  tabs: Array.from(document.querySelectorAll<HTMLButtonElement>(".tab")),
};

const graph = createGraph(dom.svg, dom.tooltip, { onSelect: (selection) => void applySelection(selection) });

function panelContext(): PanelContext {
  if (!state.topology) throw new Error("拓扑尚未加载");
  return { topology: state.topology, filesByGroup: state.filesByGroup, fileCache: state.fileCache };
}

const handlers: PanelHandlers = {
  select: (selection) => void applySelection(selection),
  openFile: (fileId, highlight, jumpTo) => void openFile(fileId, highlight ?? null, jumpTo),
};

// ── 渲染 ─────────────────────────────────────────────

function renderGraph(): void {
  if (!state.topology) return;
  const model = buildGraph(state.topology, state.filters);
  graph.render(model, state.selection);
}

function renderSummary(): void {
  if (!state.topology) return;
  const { docs, edges, flags } = state.topology;
  const services = docs.reduce((total, doc) => total + doc.services.length, 0);
  dom.summary.textContent = `${docs.length} 个编排 · ${services} 个服务 · ${edges.length} 条关系 · 开关来源 ${flags.source ?? "未找到 deploy.env"}`;
}

function renderLegend(): void {
  dom.legend.replaceChildren();
  const items: Array<[string, string]> = [
    ["#64748b", "include"],
    ["#38bdf8", "共享网络"],
    ["#a78bfa", "服务引用"],
    ["#ef4444", "虚线 = 目标被开关关闭"],
  ];
  for (const [color, text] of items) {
    const item = document.createElement("span");
    const dash = document.createElement("i");
    dash.style.background = color;
    item.append(dash, document.createTextNode(text));
    dom.legend.append(item);
  }
}

function renderPanel(): void {
  if (!state.topology) return;
  const context = panelContext();
  for (const tab of dom.tabs) tab.classList.toggle("is-active", tab.dataset.tab === state.tab);
  dom.detail.hidden = state.tab !== "detail";
  dom.files.hidden = state.tab !== "files";
  dom.warnings.hidden = state.tab !== "warnings";

  if (state.tab === "detail") renderDetailTab(dom.detail, context, state.selection, handlers);
  if (state.tab === "files") renderFilesTab(dom.files, context, state.files, handlers);
  if (state.tab === "warnings") renderWarningsTab(dom.warnings, context, handlers);

  const warningTotal = state.topology.warnings.length + state.topology.flags.warnings.length;
  dom.warningCount.textContent = String(warningTotal);
}

function render(): void {
  renderSummary();
  renderGraph();
  renderPanel();
}

// ── 交互 ─────────────────────────────────────────────

async function load(): Promise<void> {
  try {
    const topology = await fetchTopology();
    const files = await fetchFiles();
    state.topology = topology;
    state.filesByGroup = new Map();
    for (const file of files) {
      const key = file.group ?? "docker";
      const bucket = state.filesByGroup.get(key) ?? [];
      bucket.push(file);
      state.filesByGroup.set(key, bucket);
    }
    renderLegend();
    render();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dom.summary.textContent = `加载失败：${message}`;
    dom.detail.replaceChildren();
    const notice = document.createElement("p");
    notice.className = "notice";
    notice.textContent = `无法连接本地服务（${message}）。确认它还在运行：cd docker/compose-explorer && bun run start`;
    dom.detail.append(notice);
  }
}

async function ensureFile(fileId: string): Promise<FileContent | null> {
  const cached = state.fileCache.get(fileId);
  if (cached) return cached;
  try {
    const content = await fetchFile(fileId);
    state.fileCache.set(fileId, content);
    return content;
  } catch (error) {
    state.files = { ...state.files, fileId: null };
    renderPanel();
    const notice = document.createElement("p");
    notice.className = "notice";
    notice.textContent = `读取 ${fileId} 失败：${error instanceof Error ? error.message : String(error)}`;
    dom.files.prepend(notice);
    return null;
  }
}

async function openFile(fileId: string, highlight: [number, number] | null = null, jumpTo?: number): Promise<void> {
  state.tab = "files";
  state.files = { docId: state.files.docId, fileId, highlight };
  renderPanel();
  const content = await ensureFile(fileId);
  if (content) renderPanel();
  if (jumpTo !== undefined) revealLine(dom.files, jumpTo);
}

async function applySelection(selection: Selection): Promise<void> {
  state.selection = selection;
  renderGraph();

  if (!selection) {
    state.tab = "detail";
    renderPanel();
    return;
  }

  if (selection.kind === "edge") {
    state.tab = "detail";
    renderPanel();
    return;
  }

  // 点编排节点：详情先渲染好，同时直接把该编排的 compose 文件打开给对方看。
  state.files = { docId: selection.docId, fileId: null, highlight: null };
  state.tab = "detail";
  renderPanel();

  const doc = state.topology?.docs.find((item) => item.id === selection.docId);
  if (doc) await openFile(doc.relPath);
}

// ── 事件绑定 ─────────────────────────────────────────

for (const tab of dom.tabs) {
  tab.addEventListener("click", () => {
    state.tab = (tab.dataset.tab ?? "detail") as TabName;
    renderPanel();
  });
}

let searchTimer = 0;
dom.search.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.filters = { ...state.filters, search: dom.search.value };
    renderGraph();
  }, 150);
});

for (const checkbox of Array.from(document.querySelectorAll<HTMLInputElement>("input[data-kind]"))) {
  checkbox.addEventListener("change", () => {
    const kind = checkbox.dataset.kind as EdgeKind;
    state.filters = { ...state.filters, kinds: { ...state.filters.kinds, [kind]: checkbox.checked } };
    renderGraph();
  });
}

document.querySelector("#reset-view")?.addEventListener("click", () => graph.resetView());

document.querySelector("#refresh")?.addEventListener("click", async () => {
  const button = document.querySelector<HTMLButtonElement>("#refresh");
  if (button) button.disabled = true;
  try {
    await refreshTopology();
    state.fileCache.clear();
    await load();
  } catch (error) {
    dom.summary.textContent = `重新扫描失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (button) button.disabled = false;
  }
});

// 分隔条：拖动改面板宽度（纯 UI 状态，不落盘）
dom.splitter.addEventListener("pointerdown", (event) => {
  dom.splitter.setPointerCapture(event.pointerId);
  dom.splitter.classList.add("is-dragging");
  const onMove = (move: PointerEvent): void => {
    const width = Math.min(window.innerWidth * 0.7, Math.max(320, window.innerWidth - move.clientX));
    dom.panel.style.width = `${width}px`;
  };
  const onUp = (up: PointerEvent): void => {
    dom.splitter.releasePointerCapture(up.pointerId);
    dom.splitter.classList.remove("is-dragging");
    dom.splitter.removeEventListener("pointermove", onMove);
    dom.splitter.removeEventListener("pointerup", onUp);
  };
  dom.splitter.addEventListener("pointermove", onMove);
  dom.splitter.addEventListener("pointerup", onUp);
});

window.addEventListener("resize", () => renderGraph());

void load();
