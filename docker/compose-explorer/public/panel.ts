/**
 * 右侧面板：详情 / 文件 / 告警三个 Tab 的渲染。
 *
 * 渲染函数是纯的（数据进、DOM 出），状态与取数留在 main.ts：这样「点服务 → 打开文件并高亮该服务块」
 * 与「点证据 → 跳到对应行」只需要改一份状态再重渲染，不会出现两处 DOM 各自维护状态。
 */

import { highlightLine } from "./highlight.ts";
import type {
  EdgeEvidence,
  FileContent,
  FileSummary,
  Selection,
  Topology,
  TopologyDoc,
  TopologyEdge,
} from "./types.ts";

export type PanelContext = {
  topology: Topology;
  filesByGroup: Map<string, FileSummary[]>;
  fileCache: Map<string, FileContent>;
};

export type PanelHandlers = {
  /** 选中一个编排节点 */
  select: (selection: Selection) => void;
  /** 打开文件并以可选的行区间高亮 */
  openFile: (fileId: string, highlight?: [number, number] | null, jumpTo?: number) => void;
};

const KIND_LABEL: Record<string, string> = {
  include: "include 引入",
  network: "共享网络",
  service: "服务引用",
  depends_on: "depends_on",
};

const ROLE_LABEL: Record<TopologyDoc["role"], string> = {
  root: "顶层编排",
  base: "基础服务（被顶层 include）",
  dependency: "依赖目录",
};

const FILE_ORDER: Record<FileSummary["kind"], number> = {
  compose: 0,
  readme: 1,
  "env-example": 2,
  dockerfile: 3,
  script: 4,
  config: 5,
  doc: 6,
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; html?: string } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;
  return node;
}

function badge(text: string, variant?: "ok" | "warn" | "danger" | "off" | "root" | "base"): HTMLElement {
  return el("span", { className: `badge${variant ? ` ${variant}` : ""}`, text });
}

function section(title: string): HTMLElement {
  return el("h3", { text: title });
}

function stateBadge(state: TopologyDoc["featureState"], flag: string | null): HTMLElement {
  if (state === "enabled") return badge(`● ${flag ?? "常驻启用"}`, "ok");
  if (state === "disabled") return badge(`○ ${flag} = false`, "warn");
  return badge(`○ ${flag} 未声明`, "off");
}

function row(children: HTMLElement[], onClick?: () => void, extraClass = ""): HTMLElement {
  const element = el("button", { className: `row ${extraClass}`.trim() });
  element.type = "button";
  element.append(...children);
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

function evidenceRow(evidence: EdgeEvidence, handlers: PanelHandlers): HTMLElement {
  const dot = el("span", { className: "dot" });
  const main = el("span", { className: "mono grow", text: `${evidence.fromService} · ${evidence.path}` });
  const location = el("span", { className: "note", text: `${evidence.file}:${evidence.line}` });
  return row([dot, main, location], () =>
    handlers.openFile(evidence.file, [evidence.line, evidence.line], evidence.line),
  );
}

/** 详情 Tab：编排节点或一条聚合边的细节。 */
export function renderDetailTab(
  container: HTMLElement,
  context: PanelContext,
  selection: Selection,
  handlers: PanelHandlers,
): void {
  container.replaceChildren();

  if (!selection) {
    const tip = el("p", { className: "empty" });
    tip.textContent = "点击图中的编排节点或连线查看细节；点击节点后可打开它的 compose 文件、README 与初始化脚本。";
    container.append(tip, section("全部编排"), renderDocIndex(context, handlers));
    return;
  }

  if (selection.kind === "doc") {
    const doc = context.topology.docs.find((item) => item.id === selection.docId);
    if (!doc) {
      container.append(el("p", { className: "empty", text: "节点已不存在，点「重新扫描」刷新。" }));
      return;
    }
    renderDocDetail(container, context, doc, handlers);
    return;
  }

  renderEdgeDetail(container, context, selection.edgeId, handlers);
}

function renderDocIndex(context: PanelContext, handlers: PanelHandlers): HTMLElement {
  const list = el("div", { className: "rows" });
  for (const doc of context.topology.docs) {
    list.append(
      row(
        [
          el("span", { className: "mono grow", text: doc.label }),
          el("span", { className: "note", text: `${doc.services.length} 服务` }),
        ],
        () => handlers.select({ kind: "doc", docId: doc.id }),
      ),
    );
  }
  return list;
}

function renderDocDetail(
  container: HTMLElement,
  context: PanelContext,
  doc: TopologyDoc,
  handlers: PanelHandlers,
): void {
  container.append(el("h2", { text: doc.variant ? `${doc.label} · 部署变体` : doc.label }));
  container.append(
    el("div", {
      className: "path",
      text: `${doc.relPath}${doc.projectName ? `  ·  project: ${doc.projectName}` : ""}`,
    }),
  );

  const badges = el("div", { className: "badges" });
  badges.append(badge(ROLE_LABEL[doc.role], doc.role === "root" ? "root" : doc.role === "base" ? "base" : undefined));
  badges.append(stateBadge(doc.featureState, doc.featureFlag));
  badges.append(badge(`${doc.services.length} 个服务`));
  if (doc.networks.length > 0) badges.append(badge(`网络：${doc.networks.map((n) => n.name ?? n.key).join(", ")}`));
  if (doc.namedVolumes.length > 0) badges.append(badge(`命名卷：${doc.namedVolumes.join(", ")}`, "warn"));
  if (doc.isolated) badges.append(badge("与其它编排无结构关系", "off"));
  container.append(badges);

  if (doc.parseErrors.length > 0) {
    const notice = el("p", { className: "notice", text: `YAML 解析告警：${doc.parseErrors.join("；")}` });
    container.append(notice);
  }

  const outgoing = context.topology.edges.filter((edge) => edge.from.doc === doc.id && edge.to.doc !== doc.id);
  const incoming = context.topology.edges.filter((edge) => edge.to.doc === doc.id && edge.from.doc !== doc.id);

  container.append(section(`依赖（本文件 → 目标，${outgoing.length}）`));
  container.append(
    outgoing.length === 0 ? el("p", { className: "empty", text: "无" }) : renderEdgeList(context, outgoing, handlers),
  );

  container.append(section(`被依赖（来源 → 本文件，${incoming.length}）`));
  container.append(
    incoming.length === 0 ? el("p", { className: "empty", text: "无" }) : renderEdgeList(context, incoming, handlers),
  );

  container.append(section(`服务（${doc.services.length}）`));
  const services = el("div", { className: "rows" });
  for (const service of doc.services) {
    const badgesText: string[] = [];
    if (service.oneShot) badgesText.push("一次性");
    if (service.privileged) badgesText.push("privileged");
    if (service.profileFlag)
      badgesText.push(`${service.profileFlag}=${service.state === "enabled" ? "true" : "未启用"}`);
    if (service.dependsOn.length > 0)
      badgesText.push(`depends_on ${service.dependsOn.map((item) => item.service).join(", ")}`);
    services.append(
      row(
        [
          el("span", { className: "mono", text: service.name }),
          el("span", { className: "grow note", text: service.image ?? service.dockerfile ?? "" }),
          el("span", { className: "note", text: badgesText.join(" · ") }),
        ],
        () => handlers.openFile(doc.relPath, [service.lineStart, service.lineEnd], service.lineStart),
      ),
    );
  }
  container.append(services);

  container.append(section("文件"));
  container.append(renderFileChips(context, doc.id, handlers));
}

function renderEdgeList(context: PanelContext, edges: TopologyEdge[], handlers: PanelHandlers): HTMLElement {
  const list = el("div", { className: "rows" });
  for (const edge of edges) {
    const outgoing = edge.to.doc;
    const other = context.topology.docs.find((doc) => doc.id === outgoing);
    const detail = edge.kind === "network" ? edge.label : edge.evidence.length > 0 ? summaryOf(edge) : edge.label;
    list.append(
      row(
        [
          el("span", { className: `dot ${edge.kind}` }),
          el("span", { className: "mono", text: edge.satisfied ? "→" : "⇢" }),
          el("span", {
            className: "mono grow",
            text: `${other?.label ?? outgoing}${edge.from.service ? ` · ${edge.from.service}` : ""}`,
          }),
          el("span", {
            className: "note",
            text: `${KIND_LABEL[edge.kind]}${detail ? `：${detail}` : ""}${edge.satisfied ? "" : ` · 依赖未满足（${edge.blockedBy ?? "目标未启用"}）`}`,
          }),
        ],
        () => handlers.select({ kind: "doc", docId: edge.to.doc }),
        edge.satisfied ? "" : "unsatisfied",
      ),
    );
  }
  return list;
}

function summaryOf(edge: TopologyEdge): string {
  const tokens = [...new Set(edge.evidence.map((item) => item.token))];
  return tokens.join(" / ");
}

function renderEdgeDetail(
  container: HTMLElement,
  context: PanelContext,
  edgeId: string,
  handlers: PanelHandlers,
): void {
  const [fromId, toId] = edgeId.split("|");
  const from = context.topology.docs.find((doc) => doc.id === fromId);
  const to = context.topology.docs.find((doc) => doc.id === toId);
  const edges = context.topology.edges.filter((edge) => edge.from.doc === fromId && edge.to.doc === toId);

  container.append(el("h2", { text: `${from?.label ?? fromId} → ${to?.label ?? toId}` }));
  container.append(el("div", { className: "path", text: `${fromId}  →  ${toId}` }));

  const badges = el("div", { className: "badges" });
  badges.append(badge(KIND_LABEL[edges[0]?.kind ?? "service"] ?? "关系"));
  badges.append(badge(`${edges.length} 条引用`));
  const blocked = edges.filter((edge) => !edge.satisfied);
  if (blocked.length > 0) badges.append(badge(`未满足：${blocked[0]?.blockedBy ?? "目标未启用"}`, "danger"));
  container.append(badges);

  const evidence = edges.flatMap((edge) => edge.evidence);
  container.append(section(`证据（${evidence.length}）`));
  if (evidence.length === 0) {
    container.append(
      el("p", {
        className: "empty",
        text:
          edges[0]?.kind === "network"
            ? "共享网络关系来自「服务接入 external 网络」的声明，没有值级证据。"
            : "该关系来自 include 或 depends_on 的结构声明。",
      }),
    );
  } else {
    const list = el("div", { className: "rows" });
    for (const item of evidence) list.append(evidenceRow(item, handlers));
    container.append(list);
  }

  container.append(section("相关文件"));
  for (const docId of [fromId, toId]) {
    const title = context.topology.docs.find((doc) => doc.id === docId);
    container.append(el("div", { className: "path", text: title?.relPath ?? docId }));
    container.append(renderFileChips(context, docId, handlers));
  }
}

function renderFileChips(context: PanelContext, docId: string, handlers: PanelHandlers): HTMLElement {
  const wrap = el("div", { className: "file-tabs" });
  const files = (context.filesByGroup.get(docId) ?? [])
    .slice()
    .sort((a, b) => FILE_ORDER[a.kind] - FILE_ORDER[b.kind] || a.relPath.localeCompare(b.relPath));
  if (files.length === 0) {
    wrap.append(el("span", { className: "empty", text: "该目录下没有可展示的文本文件（.env 与数据目录不索引）" }));
    return wrap;
  }
  for (const file of files) {
    const chip = el("button", { className: "file-tab", text: file.relPath });
    chip.type = "button";
    chip.addEventListener("click", () => handlers.openFile(file.id));
    wrap.append(chip);
  }
  return wrap;
}

/** 文件 Tab：文件列表 + 代码视图（带行号与高亮区间）。 */
export function renderFilesTab(
  container: HTMLElement,
  context: PanelContext,
  state: { docId: string | null; fileId: string | null; highlight: [number, number] | null },
  handlers: PanelHandlers,
): void {
  container.replaceChildren();

  if (state.docId) {
    const doc = context.topology.docs.find((item) => item.id === state.docId);
    container.append(el("div", { className: "path", text: doc ? `${doc.label} · ${doc.relPath}` : state.docId }));
    container.append(renderFileChips(context, state.docId, handlers));
  } else {
    const all = context.topology.docs;
    const wrap = el("div", { className: "file-tabs" });
    for (const doc of all) {
      const chip = el("button", { className: "file-tab", text: doc.label });
      chip.type = "button";
      chip.addEventListener("click", () => handlers.select({ kind: "doc", docId: doc.id }));
      wrap.append(chip);
    }
    container.append(el("p", { className: "empty", text: "先选一个编排，或直接点下面的目录：" }));
    container.append(wrap);
    return;
  }

  if (!state.fileId) {
    container.append(el("p", { className: "empty", text: "点上面的文件名查看内容。" }));
    return;
  }

  const content = context.fileCache.get(state.fileId);
  if (!content) {
    container.append(el("p", { className: "empty", text: `正在读取 ${state.fileId} …` }));
    return;
  }

  const head = el("div", { className: "code-head" });
  head.append(el("div", { className: "path", text: content.id }));
  head.append(badge(`${content.lineCount} 行`, "off"));
  container.append(head);

  if (content.truncated) {
    container.append(el("p", { className: "notice", text: "文件超过 400 KB，仅展示前 400 KB。" }));
  }

  container.append(renderCodeViewer(content, state.highlight));
}

export function renderCodeViewer(content: FileContent, highlight: [number, number] | null): HTMLElement {
  const wrapper = el("div", { className: "code" });
  const table = el("table");
  const lines = content.content.split("\n");
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const tr = el("tr");
    if (highlight && lineNumber >= highlight[0] && lineNumber <= highlight[1]) tr.className = "hl";
    tr.dataset.line = String(lineNumber);
    const ln = el("td", { className: "ln", text: String(lineNumber) });
    const code = el("td", { html: highlightLine(line, content.language) });
    tr.append(ln, code);
    table.append(tr);
  });
  wrapper.append(table);
  return wrapper;
}

/** 滚动到指定行并闪一下，用于「点证据跳到那一行」。 */
export function revealLine(container: HTMLElement, line: number): void {
  const target = container.querySelector<HTMLElement>(`tr[data-line="${line}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  target.classList.add("flash");
  window.setTimeout(() => target.classList.remove("flash"), 1200);
}

/** 告警 Tab：全部结构告警 + 开关解析告警。 */
export function renderWarningsTab(container: HTMLElement, context: PanelContext, handlers: PanelHandlers): void {
  container.replaceChildren();
  const { warnings, flags } = context.topology;

  container.append(el("h2", { text: "结构告警" }));
  container.append(
    el("div", {
      className: "path",
      text: `来源：${flags.source ?? "未找到 docker/deploy.env"} · 开关 ${Object.keys(flags.values).length} 项 · 生成于 ${context.topology.generatedAt}`,
    }),
  );
  container.append(
    el("p", {
      className: "empty",
      html: "口径：跨项目引用是否可达、同名服务是否冲突、依赖目标是否被开关关闭、是否使用了命名卷。",
    }),
  );

  for (const warning of warnings) {
    const item = el("div", { className: `warn-item ${warning.level}` });
    item.append(el("div", { className: "grow", text: warning.message }));
    if (warning.doc) {
      const chip = el("button", { className: "file-tab", text: warning.doc.split("/").slice(-2).join("/") });
      chip.type = "button";
      chip.addEventListener("click", () => handlers.select({ kind: "doc", docId: warning.doc ?? "" }));
      item.append(chip);
    }
    container.append(item);
  }
  for (const warning of flags.warnings) {
    container.append(el("div", { className: "warn-item", text: warning }));
  }
  if (warnings.length === 0 && flags.warnings.length === 0) {
    container.append(el("p", { className: "empty", text: "没有告警。" }));
  }
}
