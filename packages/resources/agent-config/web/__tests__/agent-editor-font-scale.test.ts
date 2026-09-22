// web/__tests__/agent-editor-font-scale.test.ts
// 「新建Agent」面板（agent-editor 集群）Tailwind 迁移 + 字号刻度守卫。
//
// 迁移口径：面板原有 9 份手写 CSS（2437 行）全部改成渲染点的 Tailwind 工具类，字号用工具类表达。
// 旧值基准是迁移前逐字快照（`/tmp/agent-editor-css-baseline/`，随本次迁移报告归档），本文件的冻结值
// 即该快照按 import 顺序求解层叠后的**生效值**——不是某一层的中间值。
//
// 为什么必须静态断言（迁移期与迁移后同样成立）：面板字号分两层写（`agent-editor.css` 基准层与
// `agent-editor-design / form-fields / form-surfaces / library / knowledge` 设计层），同一条规则常在
// 两层各写一次，靠 `AgentFormDialog.tsx` 的 import 顺序决定谁生效。迁移后两边变成同一层的工具类，
// 胜负退化成「样式表里的生成顺序」——不可控。漏改一处不会报错，只会在界面上表现为「同一组件里同角色
// 文字大小不一致」，没有任何运行时断言能发现它。
//
// 本文件断言七件事：
//   ① 每个分片的 CSS 是**整片**删除（不允许删一半），且删干净的片其 tsx 里不再有语义类名；
//   ② 面板 JSX 里的字号工具类只有 8/10/11/12/13/14/16/17/18（+ 窄屏图标化按钮的 0），不出现 Tailwind 文字刻度类；
//   ③ 字符串类名里同一变体（同属性）只有一个字号类，不允许「挂两个同属性工具类」；
//   ④ 关键角色的字号按锚点冻结（含 760–1399px 压到 16px、759px 图标化归 0 两处有意例外）；
//   ⑤ 迁移完成后目录里只剩登记的关键帧 CSS，且它不含任何选择器规则；
//   ⑥ 分区入场动画的关键帧与引用都在（关键帧无法用工具类表达，是唯一登记的保留项）；
//   ⑦ `AgentFormDialog.tsx` 不再有面板 CSS 的副作用导入。
//
// 拦得住：越界字号、同属性双值、分片半删、语义类名回流、锚点角色字号漂移、关键帧丢失。
// 拦不住：① 清单外新增的文字元素（新元素必须登记进 ROLE_ANCHORS 才受 ④ 保护）；
// ② 运行时动态挂载、面板工具类管不到的元素（如 ui-components 内部节点）；
// ③ 断点下「有意缩放」的幅度是否合理（只校验它落回刻度、且等于冻结值）；
// ④ 非字号属性（间距/颜色/圆角）是否与旧 CSS 逐条相等——那部分靠逐条映射台账 + 人工复核。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EDITOR_DIR = resolve(import.meta.dir, "../pages/agent-panel/agent-editor");
const DIALOG_FILE = join(EDITOR_DIR, "AgentFormDialog.tsx");

/**
 * 迁移分片：「本片负责的 CSS 文件」+「每个 CSS 文件定义过的类名」。
 *
 * 判据用的是**类名并集**：一个类名只要还被未迁移的 CSS 文件定义，就允许继续挂在 className 上；
 * 只有当定义它的文件全部迁完，它才必须从 className 里消失。慢一步删类名不会让样式失效
 * （未分层 CSS 仍然生效），但删早了会让元素失去样式——所以门控必须精确到「谁在定义它」。
 */
const CSS_CLASS_NAMES: Record<string, string[]> = {
  "agent-editor.css": [
    "agent-panel-body",
    "agent-editor-shell",
    "agent-editor-panel",
    "agent-editor-root",
    "agent-editor-header",
    "agent-editor-header-identity",
    "agent-editor-header-actions",
    "agent-editor-title-row",
    "agent-editor-avatar",
    "agent-editor-save-meta",
    "agent-editor-template-button",
    "agent-editor-map",
    "agent-editor-map-label",
    "agent-editor-map-icon",
    "agent-editor-map-copy",
    "agent-editor-content",
    "agent-editor-workspace",
    "agent-editor-section__intro",
    "agent-editor-identity-fields",
    "agent-editor-description-field",
    "agent-editor-prompt-field",
    "agent-editor-prompt-label",
    "agent-editor-summary",
    "agent-editor-summary-eyebrow",
    "agent-editor-summary-cards",
    "agent-editor-summary-note",
    "agent-editor-summary-safety",
    "agent-editor-footer",
    "agent-editor-switch-row",
    "agent-editor-switch-copy",
    "agent-editor-state",
    "agent-editor-readonly",
    "agent-editor-resource-error",
    "agent-editor-validation-summary",
    "agent-editor-field-error",
    "agent-model-options",
  ],
  "agent-editor-design.css": [
    "agent-editor-panel",
    "agent-editor-header",
    "agent-editor-header-identity",
    "agent-editor-avatar",
    "agent-editor-save-meta",
    "agent-editor-template-button",
    "agent-editor-root",
    "agent-editor-header-actions",
    "agent-editor-close",
    "agent-editor-workspace",
    "agent-editor-map",
    "agent-editor-map-label",
    "agent-editor-map-icon",
    "agent-editor-map-copy",
    "agent-editor-readiness",
    "agent-editor-content",
    "agent-editor-section",
    "agent-editor-section__intro",
    "agent-editor-summary",
    "agent-editor-summary-eyebrow",
    "agent-editor-summary-cards",
    "agent-editor-summary-note",
    "agent-editor-summary-safety",
    "agent-editor-template-picker",
    "agent-editor-template-picker__header",
    "agent-editor-template-picker__search",
    "agent-editor-template-picker__list",
    "agent-editor-footer",
    "agent-editor-footer__state",
    "agent-editor-footer__actions",
    "agent-editor-reset",
    "is-primary",
  ],
  "agent-editor-responsive.css": [
    "agent-editor-panel",
    "agent-editor-mobile",
    "agent-editor-header",
    "agent-editor-save-meta",
    "agent-editor-title-row",
    "agent-editor-template-button",
    "agent-editor-workspace",
    "agent-editor-map",
    "agent-editor-map-label",
    "agent-editor-readiness",
    "agent-editor-content",
    "agent-editor-identity-fields",
    "agent-editor-field--agent-id",
    "agent-editor-field--description",
    "agent-editor-field--prompt",
    "agent-editor-library-picker",
    "agent-editor-group-filter",
    "agent-editor-footer",
    "agent-editor-summary",
  ],
  "agent-editor-form-fields.css": [
    "agent-editor-root",
    "agent-editor-input",
    "agent-editor-textarea",
    "agent-resource-picker__search",
    "agent-single-picker-toolbar",
    "agent-editor-field",
    "agent-editor-field__label",
    "agent-editor-form-grid",
    "agent-editor-field--description",
    "agent-editor-field--prompt",
    "agent-editor-agent-id-row",
    "agent-editor-button",
    "agent-editor-stepper",
    "agent-editor-prompt-editor",
    "agent-editor-guidance",
    "agent-model-options",
    "agent-node-list",
    "agent-resource-picker",
    "agent-resource-picker__list",
    "agent-resource-picker__chips",
    "agent-resource-picker__copy",
    "agent-resource-picker__selected",
    "agent-resource-picker__empty",
    "agent-capability-tabs",
    "is-selected",
    "is-unavailable",
    "is-active",
  ],
  "agent-editor-form-surfaces.css": [
    "agent-editor-root",
    "agent-editor-switch",
    "agent-editor-toggle-row",
    "agent-editor-toggle-row__copy",
    "agent-editor-toggle-row__icon",
    "agent-editor-form-grid",
    "agent-editor-field",
    "agent-model-options",
    "agent-model-options__icon",
    "agent-model-options__copy",
    "agent-model-summary",
    "agent-node-list",
    "agent-single-picker-toolbar",
    "agent-single-picker-current",
    "agent-owner-card",
    "agent-access-preview",
    "agent-runtime-note",
    "is-on",
    "is-selected",
    "is-unavailable",
  ],
  "agent-editor-library.css": [
    "agent-editor-root",
    "agent-editor-library-picker",
    "agent-editor-group-filter",
    "agent-editor-library-picker__results",
    "agent-editor-pagination",
    "agent-resource-picker",
    "agent-resource-picker__list",
    "agent-resource-picker__icon",
    "is-flat",
    "is-active",
  ],
  "agent-editor-knowledge.css": [
    "agent-editor-root",
    "agent-knowledge-layout",
    "agent-knowledge-block",
    "agent-knowledge-block__heading",
    "agent-knowledge-block__body",
    "agent-knowledge-block--bases",
    "agent-knowledge-switch",
    "agent-retrieval-fields",
    "agent-retrieval-options",
    "agent-editor-field",
    "agent-resource-picker",
    "is-on",
  ],
  "agent-editor-loading.css": [
    "agent-editor-loading-shell",
    "agent-editor-loading-shell__map",
    "agent-editor-loading-shell__fields",
    "agent-editor-title-row",
    "agent-editor-save-meta",
    "agent-editor-footer",
    "is-active",
    "is-wide",
  ],
  "agent-editor-form-responsive.css": [
    "agent-editor-root",
    "agent-editor-workspace",
    "agent-editor-summary",
    "agent-editor-summary-cards",
    "agent-editor-map",
    "agent-editor-map-icon",
    "agent-editor-map-copy",
    "agent-editor-content",
    "agent-editor-section__intro",
    "agent-editor-header",
    "agent-editor-footer",
    "agent-editor-footer__actions",
    "agent-editor-form-grid",
    "agent-editor-field",
    "agent-editor-prompt-editor",
    "agent-editor-guidance",
    "agent-model-options",
    "agent-node-list",
    "agent-editor-library-picker",
    "agent-editor-group-filter",
    "agent-resource-picker__list",
    "agent-editor-summary-note",
    "agent-editor-summary-safety",
    "agent-editor-toggle-row",
    "agent-editor-pagination",
    "agent-resource-picker__search",
    "agent-resource-picker__selected",
    "agent-editor-readiness",
    "agent-editor-template-picker",
  ],
};

const SLICES = [
  {
    name: "A1 加载壳",
    cssFiles: ["agent-editor-loading.css"],
    tsxFiles: ["AgentEditorLoadingShell.tsx", "AgentEditorChrome.tsx", "AgentFormDialog.tsx"],
  },
  {
    name: "A2 外壳 / 头部 / 汇总",
    cssFiles: ["agent-editor.css", "agent-editor-design.css", "agent-editor-responsive.css"],
    tsxFiles: [
      "AgentEditorChrome.tsx",
      "AgentFormDialog.tsx",
      "AgentEditorLoadingShell.tsx",
      "agent-editor-classes.ts",
      "agent-editor-controls.tsx",
      "AgentEditorSections.tsx",
      "AgentKnowledgeSection.tsx",
    ],
  },
  {
    name: "B 表单字段与卡片表面",
    cssFiles: ["agent-editor-form-fields.css", "agent-editor-form-surfaces.css", "agent-editor-form-responsive.css"],
    tsxFiles: [
      "agent-editor-controls.tsx",
      "AgentEditorSections.tsx",
      "AgentFormDialog.tsx",
      "AgentResourcePicker.tsx",
      "AgentKnowledgeSection.tsx",
      "agent-editor-form-classes.ts",
    ],
  },
  {
    name: "C 资源库与知识区",
    cssFiles: ["agent-editor-library.css", "agent-editor-knowledge.css"],
    tsxFiles: [
      "AgentResourcePicker.tsx",
      "AgentKnowledgeSection.tsx",
      "agent-editor-controls.tsx",
      "agent-editor-library-classes.ts",
    ],
  },
] as const;

/** 迁移完成后唯一允许保留的样式表：关键帧 + 登记过的宿主钩子（两者都无法用工具类表达）。 */
const RETAINED_FILE = "agent-editor-retained.css";
/** 保留文件里唯一登记的宿主钩子选择器（`.agent-panel-body` 由宿主 `apps/web` 渲染，见文件注释）。 */
const RETAINED_HOST_HOOK = ".agent-panel-body";

/** 冻结刻度：八档 + 窄屏图标化按钮的 0。 */
const SCALE = [8, 10, 11, 12, 13, 14, 16, 17, 18];

/**
 * 已迁移的分片（判据 = 该片 CSS 文件全部消失）。
 * 用文件系统派生而不是手写开关：漏删一半会被 ① 抓到，删干净才进入该片的其余断言。
 */
function migrated(slice: (typeof SLICES)[number]): boolean {
  return slice.cssFiles.every((file) => !existsSync(join(EDITOR_DIR, file)));
}
const migratedSlices = SLICES.filter(migrated);
/** 全部迁完才成立的终态断言（①⑤⑥⑦）以此为门。 */
const allMigrated = migratedSlices.length === SLICES.length;

/**
 * 迁移后不应再出现在 `className` 里的语义类名前缀（各 CSS 文件的源选择器）。
 * 例外：无——保留项只有关键帧文件，没有靠类名当钩子的样式表。
 */
const RETIRED_PREFIXES = [
  "agent-editor",
  "agent-resource-picker",
  "agent-template",
  "agent-composition",
  "agent-owner-card",
  "agent-model-",
  "agent-node-list",
  "agent-single-picker",
  "agent-json-editor",
  "agent-change-impact",
  "agent-memory-section",
  "agent-summary-",
  "agent-policy-card",
  "agent-capability-tabs",
  "agent-access-preview",
  "agent-runtime-note",
  "agent-result-limit",
  "agent-knowledge-",
  "agent-retrieval-",
  "agent-panel-body",
  "is-flat",
  "is-wide",
  "has-icon",
];

/**
 * 关键角色锚点表：`data-slot` 锚点 → 该元素 className 必须命中的字号模式（冻结值）。
 * 模式写成正则是因为父子/状态变体可等价互换（`[&>strong]:` / `[&_strong]:` / `group-hover/x:`），
 * 但**字号数值与锚点名不允许漂移**。含 759px 归 0、760–1399px 压 16px 两处有意例外。
 */
const ROLE_ANCHORS: Array<{ slice: string; slot: string; note: string; patterns: RegExp[] }> = [
  { slice: "A2", slot: "editor-title", note: "面板标题", patterns: [/:?text-\[14px\]/] },
  { slice: "A2", slot: "editor-status-pill", note: "运行状态 pill", patterns: [/:?text-\[10px\]/] },
  { slice: "A2", slot: "editor-subtitle", note: "面板副标题", patterns: [/:?text-\[11px\]/] },
  { slice: "A2", slot: "editor-map-label", note: "左栏分组标签", patterns: [/:?text-\[10px\]/] },
  {
    slice: "A2",
    slot: "editor-map-copy",
    note: "左栏条目标题与说明",
    patterns: [/\[&[>_]strong\]:text-\[13px\]/, /\[&[>_]small\]:text-\[11px\]/],
  },
  { slice: "A2", slot: "editor-summary-eyebrow", note: "右栏眉标", patterns: [/:?text-\[8px\]/] },
  {
    slice: "A2",
    slot: "editor-summary-title",
    note: "右栏标题（760–1399px 压 16px）",
    patterns: [/text-\[18px\]/, /\[@media\(min-width:760px\)_and_\(max-width:1399px\)\]:text-\[16px\]/],
  },
  {
    slice: "A2",
    slot: "editor-template-header",
    note: "模板对话框头部（对话框标题 17px）",
    // 眉标（8px）在本模板对话框里是直接挂在 `<span>` 上的 `EYEBROW` 常量（与右栏共用），
    // 由 `editor-summary-eyebrow` 锚点 + 全局刻度断言锁定，故此处不再要求父级写 `[&>span]:` 变体。
    patterns: [/\[&[>_]h2\]:text-\[17px\]/, /\[&[>_]p\]:text-\[12px\]/],
  },
  { slice: "A2", slot: "editor-template-empty", note: "模板列表空态（曾挂 text-sm）", patterns: [/:?text-\[11px\]/] },
  {
    slice: "A2",
    slot: "editor-mobile-template",
    note: "头部模板按钮（759px 图标化归 0）",
    patterns: [/\[&[>_]button\]:!?text-\[13px\]/, /\[@media\(max-width:759px\)\]:\[&[>_]button\]:!?text-\[0px\]/],
  },
  {
    slice: "A2",
    slot: "editor-footer-state",
    note: "页脚状态块",
    patterns: [/\[&[>_]span\]:text-\[13px\]/, /\[&[>_]strong\]:text-\[13px\]/, /\[&[>_]small\]:text-\[11px\]/],
  },
  {
    slice: "B",
    slot: "editor-section-intro",
    note: "分区说明块（眉标 8 / 标题 18→16 / 说明 12）",
    patterns: [
      /\[&[>_]span\]:text-\[8px\]/,
      /\[&[>_]h3\]:text-\[18px\]/,
      /\[&[>_]p\]:text-\[12px\]/,
      /\[@media\(min-width:760px\)_and_\(max-width:1399px\)\]:\[&[>_]h3\]:text-\[16px\]/,
    ],
  },
  { slice: "B", slot: "editor-field-label", note: "字段标签", patterns: [/:?text-\[12px\]/] },
  {
    slice: "C",
    slot: "editor-knowledge-heading",
    note: "知识区块标题与说明",
    patterns: [/text-\[13px\]/, /text-\[11px\]/],
  },
];

/** 守卫扫描的源码文件（锚点与类串常量求值共用；常量集中在 agent-editor-classes.ts）。 */
const SCAN_FILES = [
  "AgentEditorChrome.tsx",
  "AgentEditorLoadingShell.tsx",
  "AgentFormDialog.tsx",
  "AgentEditorSections.tsx",
  "AgentKnowledgeSection.tsx",
  "AgentResourcePicker.tsx",
  "agent-editor-classes.ts",
  "agent-editor-form-classes.ts",
  "agent-editor-library-classes.ts",
  "agent-editor-controls.tsx",
] as const;

/** 面板里允许出现的 Tailwind 文字刻度类：无（字号一律显式 px，便于刻度守卫覆盖）。 */
const TEXT_SCALE_UTILITY = /\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\b/;

/**
 * 扫出一个 JSX 源码里所有开标签的文本（属性区），逐标签提取 `className` 值。
 * 自写扫描而非正则：属性里有箭头函数（`=>`）与对象字面量，`[^>]*` 会在 `=>` 处截断。
 */
function jsxTags(source: string, constants: Map<string, string>): Array<{ attrs: string; className: string }> {
  const tags: Array<{ attrs: string; className: string }> = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "<" || /[</!=]/.test(source[i + 1] ?? "")) continue;
    let quote: string | null = null;
    let braces = 0;
    let end = -1;
    for (let j = i + 1; j < source.length; j++) {
      const char = source[j];
      if (quote) {
        if (char === quote && source[j - 1] !== "\\") quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") braces++;
      else if (char === "}") braces--;
      else if (char === ">" && braces <= 0) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    const attrs = source.slice(i + 1, end);
    tags.push({ attrs, className: classNameOf(attrs, constants) });
    i = end;
  }
  return tags;
}

/**
 * 取一个开标签属性区里的 `className` 值：字符串字面量直取；`{…}` 表达式则取其中的字符串字面量
 * 与常量引用（`className={MAP_COPY}`、`className={cn("…", loading && "…")}`），常量经 {@link constantValues} 求值。
 */
function classNameOf(attrs: string, constants: Map<string, string>): string {
  const marker = attrs.indexOf("className=");
  if (marker < 0) return "";
  const expression = attrs.slice(marker + "className=".length);
  if (expression.startsWith('"')) return expression.slice(1, expression.indexOf('"', 1));
  if (!expression.startsWith("{")) return "";
  let depth = 0;
  let end = -1;
  for (let k = 0; k < expression.length; k++) {
    if (expression[k] === "{") depth++;
    else if (expression[k] === "}") {
      depth--;
      if (depth === 0) {
        end = k;
        break;
      }
    }
  }
  const body = end > 0 ? expression.slice(1, end) : "";
  const parts: string[] = [...body.matchAll(/(["'`])([^"'`]*)\1/g)].map((match) => match[2]);
  for (const ref of body.matchAll(/\$\{([A-Za-z_$][\w$]*)\}|\b([A-Z][A-Z0-9_]*)\b/g)) {
    const name = ref[1] ?? ref[2];
    const value = constants.get(name);
    if (value !== undefined) parts.push(value);
  }
  return resolveClassRefs(parts.join(" "), constants);
}

/**
 * 抽取源码里所有「成串的工具类字面量」：
 * ① `className="…"` / `className={`…`}`；② `cn(…)` / `clsx(…)` 的字符串参数；
 * ③ 模块级常量与其数组里的字符串——类串提成常量后 `className` 里只剩标识符，
 * 不单独收就会变成「把类串提成常量即可绕开刻度守卫」的缺口（红证时实测到过这个缺口）。
 *
 * 模板串里的 `${…}` 插值先剥掉再切词：`agent-editor-toggle-row${checked ? " is-on" : ""}`
 * 这类写法若直接按空白切，会切出 `agent-editor-toggle-row${checked` 这种假 token。
 */
function classNameLiterals(source: string): string[] {
  const literal = (text: string) => text.replace(/\$\{[^{}]*\}/g, " ");
  const out = [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)].map((match) =>
    literal(match[1] ?? match[2] ?? match[3] ?? ""),
  );
  for (const call of source.matchAll(/(?:cn|clsx)\(([\s\S]*?)\)/g)) {
    for (const match of call[1].matchAll(/(["'`])([^"'`]*)\1/g)) out.push(literal(match[2]));
  }
  for (const decl of source.matchAll(/\bconst\s+[A-Za-z_$][\w$]*\s*=\s*[^;]+;/g)) {
    for (const match of decl[0].matchAll(/(["'`])([^"'`]*)\1/g)) out.push(literal(match[2]));
  }
  return out;
}

/**
 * 类串常量表：`const NAME = "…" + "…"` / 模板串（可引用另一个常量名）求值成最终类串。
 * 锚点断言必须能看穿常量——否则 `className={MAP_COPY}` 这类写法会让字号断言假失败。
 */
function constantValues(sources: string[]): Map<string, string> {
  const raw = new Map<string, string>();
  for (const source of sources) {
    for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);\s*(?:\n|$)/g)) {
      raw.set(match[1], match[2]);
    }
  }
  const evaluate = (expression: string, seen: Set<string> = new Set()): string => {
    let out = "";
    for (const chunk of expression.split("+")) {
      for (const part of chunk.matchAll(/"([^"]*)"|`([^`]*)`|\$\{([A-Za-z_$][\w$]*)\}|([A-Za-z_$][\w$]*)/g)) {
        if (part[1] !== undefined || part[2] !== undefined) {
          out += part[1] ?? part[2];
          continue;
        }
        const name = part[3] ?? part[4];
        const referenced = raw.get(name);
        if (referenced !== undefined && !seen.has(name)) {
          out += evaluate(referenced, new Set([...seen, name]));
        }
      }
    }
    return out;
  };
  return new Map([...raw].map(([name, expression]) => [name, evaluate(expression)]));
}

/** 把 `{NAME}` / `${NAME}` 形式的类串引用替换成常量值（未登记的标识符原样保留）。 */
function resolveClassRefs(className: string, constants: Map<string, string>): string {
  return className.replace(/\$\{([A-Za-z_$][\w$]*)\}|\{([A-Za-z_$][\w$]*)\}/g, (whole, dollar, plain) => {
    const name = dollar ?? plain;
    return constants.get(name) ?? whole;
  });
}

/** 类名 token 里的字号类：`text-[Npx]`（可带变体前缀），Tailwind 刻度类另算。 */
function sizeUtilities(className: string): string[] {
  return className
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => /(^|:)text-\[[\d.]+px\]$/.test(token) || TEXT_SCALE_UTILITY.test(token));
}

function readEditorFile(name: string): string {
  return readFileSync(join(EDITOR_DIR, name), "utf8");
}

describe("Agent Editor：Tailwind 迁移与字号刻度", () => {
  // 分片必须整片迁移：删了一半的 CSS 会让「哪些声明还生效」变得不可推断，迁移期也必须保持可推理。
  test("每个分片的 CSS 文件整片删除，且删干净后不再残留语义类名", () => {
    const half = SLICES.filter((slice) => slice.cssFiles.some((file) => !existsSync(join(EDITOR_DIR, file))))
      .filter((slice) => !migrated(slice))
      .map((slice) => slice.name);
    expect(half).toEqual([]);

    // 只有「定义它的 CSS 文件全迁完」的类名才必须消失；仍被未迁移文件定义的类名继续合法（未分层 CSS 仍生效）。
    const remaining = new Set(
      SLICES.filter((slice) => !migrated(slice)).flatMap((slice) =>
        slice.cssFiles.flatMap((file) => CSS_CLASS_NAMES[file] ?? []),
      ),
    );
    const retired = new Set(
      migratedSlices.flatMap((slice) => slice.cssFiles.flatMap((file) => CSS_CLASS_NAMES[file] ?? [])),
    );
    for (const name of remaining) retired.delete(name);

    const leftovers = migratedSlices.flatMap((slice) =>
      slice.tsxFiles.flatMap((file) => {
        const hits = new Set<string>();
        for (const literal of classNameLiterals(readEditorFile(file))) {
          for (const token of literal.split(/\s+/)) {
            if (retired.has(token) || RETIRED_PREFIXES.some((prefix) => token === prefix || token.startsWith(prefix))) {
              if (!remaining.has(token)) hits.add(token);
            }
          }
        }
        return [...hits].map((token) => `${file} ${token}`);
      }),
    );
    expect(leftovers).toEqual([]);
  });

  // 字号一律显式 px 写死并受本守卫覆盖；放回 `text-sm` 这类刻度类会绕开刻度表、重新引入 13/14 混排。
  // 一个文件被多个分片共享（如 `AgentFormDialog.tsx`）时，以「所有列入它的分片都迁完」为门。
  test("面板 JSX 不出现 Tailwind 文字刻度类", () => {
    const pending = new Set(SLICES.filter((slice) => !migrated(slice)).flatMap((slice) => [...slice.tsxFiles]));
    const found = readdirSync(EDITOR_DIR)
      .filter((name) => name.endsWith(".tsx") && !pending.has(name))
      .flatMap((file) =>
        [...readEditorFile(file).matchAll(new RegExp(TEXT_SCALE_UTILITY, "g"))].map((m) => `${file} ${m[0]}`),
      );
    expect(found).toEqual([]);
  });

  // 同一元素挂两个同属性工具类时，胜负由生成顺序决定（不可控）；这正是迁移前 `text-sm` 被 CSS 压成
  // 11px 的那类隐患，必须从源头消灭。
  test("同一变体下一个 className 只有一个字号类", () => {
    const conflicts: string[] = [];
    for (const slice of migratedSlices) {
      for (const file of slice.tsxFiles) {
        for (const literal of classNameLiterals(readEditorFile(file))) {
          const byVariant = new Map<string, string[]>();
          for (const token of sizeUtilities(literal)) {
            const variant = token.slice(0, token.lastIndexOf("text-"));
            byVariant.set(variant, [...(byVariant.get(variant) ?? []), token]);
          }
          for (const [variant, tokens] of byVariant) {
            if (tokens.length > 1) conflicts.push(`${file} [${variant}] ${tokens.join(" ")}`);
          }
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  // 面板只允许八档刻度（+ 窄屏图标化按钮的 0），防止再次出现 9/15/16/19/20px 这类临时值。
  test("面板 JSX 的字号只落在冻结刻度上", () => {
    const violations: string[] = [];
    for (const slice of migratedSlices) {
      for (const file of slice.tsxFiles) {
        for (const token of classNameLiterals(readEditorFile(file)).flatMap(sizeUtilities)) {
          const px = token.match(/\[([\d.]+)px\]$/);
          if (!px) continue; // 刻度类由「不出现 Tailwind 文字刻度类」那条拦下
          const value = Number(px[1]);
          if (value !== 0 && !SCALE.includes(value)) violations.push(`${file} ${token}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // 关键角色的字号逐个锚点冻结：改数值、把 760–1399px 的 16px 覆盖删掉、或让 759px 图标化按钮
  // 重新长出文字，都会在这里变红。
  test("关键角色的字号按锚点冻结", () => {
    const missing: string[] = [];
    for (const anchor of ROLE_ANCHORS) {
      if (!migratedSlices.some((slice) => slice.name.startsWith(anchor.slice))) continue;
      const scanned = SCAN_FILES.filter((file) => existsSync(join(EDITOR_DIR, file)));
      const constants = constantValues(scanned.map(readEditorFile));
      const candidates = scanned
        .flatMap((file) => jsxTags(readEditorFile(file), constants).map((tag) => ({ file, ...tag })))
        .filter((tag) => tag.attrs.includes(`data-slot="${anchor.slot}"`));
      if (candidates.length === 0) {
        missing.push(`${anchor.slot}（${anchor.note}）锚点不存在`);
        continue;
      }
      for (const candidate of candidates) {
        for (const pattern of anchor.patterns) {
          if (!pattern.test(candidate.className)) {
            missing.push(`${anchor.slot}（${anchor.note}）缺 ${pattern} 于 ${candidate.file}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  // 迁移完成后目录里只允许留下登记文件：关键帧 + `.agent-panel-body` 宿主钩子（两者都在文件头写了移除条件）。
  test("迁移完成后只剩登记的关键帧与宿主钩子样式表", () => {
    if (!allMigrated) return;
    const remaining = readdirSync(EDITOR_DIR).filter((name) => name.endsWith(".css"));
    expect(remaining).toEqual([RETAINED_FILE]);

    // 保留文件只能是 @keyframes + 那一条宿主钩子：出现其它选择器规则就说明有声明没迁完。
    const css = readFileSync(join(EDITOR_DIR, RETAINED_FILE), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain("@keyframes agent-editor-section-enter");
    // 规则头按「`{` 之前的片段」取，而不是按「以 `{` 结尾的行」——单行规则
    // （`.agent-editor-panel { color: red; }`）会从行尾判定里漏掉（红证时实测到过这个盲区）。
    const ruleHeads = [...css.replace(/@keyframes[\s\S]*?\n\}/g, "").matchAll(/(?:^|\})\s*([.#a-zA-Z[][^{}@]*?)\s*\{/g)]
      .map((match) => match[1].trim())
      .filter((head) => !/^(from|to|\d+%)/.test(head));
    expect([...new Set(ruleHeads)]).toEqual([RETAINED_HOST_HOOK]);
  });

  // 分区入场动画：关键帧留在保留文件里，引用写在渲染点；两侧缺一都会让分区标题不再淡入。
  test("分区入场动画的关键帧与引用都在", () => {
    if (!allMigrated) return;
    expect(readFileSync(join(EDITOR_DIR, RETAINED_FILE), "utf8")).toContain("@keyframes agent-editor-section-enter");
    const referenced = SLICES.flatMap((slice) => slice.tsxFiles)
      .filter((file, index, all) => all.indexOf(file) === index)
      .some((file) => readEditorFile(file).includes("animate-[agent-editor-section-enter_180ms_ease_both]"));
    expect(referenced).toBe(true);
  });

  // 加载壳与加载完成态复用同一批声明：加载壳自己不许再写字号，否则加载态会闪出另一种排版。
  // （迁移前这条断言读 `agent-editor-loading.css` 里「不含 font-size」+ 共用选择器同值；迁移后
  //   加载壳的标题/状态 pill 直接复用 `AgentEditorHeader`，故改成「加载壳源码里没有字号工具类」。）
  test("加载壳不自带字号，全部字号来自复用的头部组件", () => {
    if (!migrated(SLICES[0])) return;
    const sizes = sizeUtilities(classNameLiterals(readEditorFile("AgentEditorLoadingShell.tsx")).join(" "));
    expect(sizes).toEqual([]);
    // 正向对照：加载壳确实复用了头部组件（否则上面的「为空」会因头部整块消失而恒真）。
    expect(readEditorFile("AgentEditorLoadingShell.tsx")).toContain("<AgentEditorHeader");
  });

  // 面板 CSS 的副作用导入必须随文件一起消失，否则构建期会去找已删除的文件；
  // 只有保留文件允许继续被副作用导入（关键帧与宿主钩子仍要进构建）。
  test("AgentFormDialog 不再副作用导入已删除的面板 CSS", () => {
    const imports = [...readFileSync(DIALOG_FILE, "utf8").matchAll(/^import "\.\/(agent-editor[\w-]*\.css)";$/gm)].map(
      (match) => match[1],
    );
    const orphaned = migratedSlices.flatMap((slice) =>
      slice.cssFiles.filter((file) => imports.includes(file)).map((file) => `${slice.name} → ${file}`),
    );
    expect(orphaned).toEqual([]);
    if (allMigrated) expect(imports).toEqual([RETAINED_FILE]);
  });
});
