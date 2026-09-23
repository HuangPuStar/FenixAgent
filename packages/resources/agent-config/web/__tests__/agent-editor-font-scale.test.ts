// web/__tests__/agent-editor-font-scale.test.ts
// 「新建Agent」面板（agent-editor 集群）Tailwind 迁移 + 字号刻度守卫。
//
// 迁移口径：面板原有 9 份手写 CSS（2437 行）全部改成渲染点的 Tailwind 工具类，字号用工具类表达。
// 旧值基准是迁移前逐字快照（`/tmp/agent-editor-css-baseline/`，随本次迁移报告归档），本文件的冻结值
// 即该快照按 import 顺序求解层叠后的**生效值**——不是某一层的中间值。
//
// 2026-09 的 Web 样式禁令整改（`docs/developer/guide/forbidden-code-patterns.md`）把这批工具类里
// **无法用扁平工具类表达**的部分（子代选择器、伪态、复合值、任意媒体查询）又下沉成了同目录同名的
// 伴随 CSS（`AgentEditorChrome.tsx` ↔ `AgentEditorChrome.css`）。于是字号变成**两处来源**：扁平处仍是
// `className` 里的刻度类，深层处（`> strong` / `> h3` 这类）写在伴随 CSS 里。守卫必须两处都看——
// 只扫 JSX 的话，占多数的 CSS 来源字号漂移了也照样绿。
//
// 为什么必须静态断言（迁移期与迁移后同样成立）：面板字号分两层写（`agent-editor.css` 基准层与
// `agent-editor-design / form-fields / form-surfaces / library / knowledge` 设计层），同一条规则常在
// 两层各写一次，靠 `AgentFormDialog.tsx` 的 import 顺序决定谁生效。迁移后两边变成同一层的工具类，
// 胜负退化成「样式表里的生成顺序」——不可控。漏改一处不会报错，只会在界面上表现为「同一组件里同角色
// 文字大小不一致」，没有任何运行时断言能发现它。
//
// 本文件断言八件事：
//   ① 每个分片的 CSS 是**整片**删除（不允许删一半），且删干净的片其 tsx 里不再有语义类名；
//   ② 面板 JSX 的字号只用白名单刻度（`text-3xs` / `text-xs` / `text-sm` / `text-base` / `text-lg`），
//      且不再出现任何任意值字号（`text-[Npx]`，含窄屏图标化的 0——它已改由伴随 CSS 表达）；
//   ③ 字符串类名里同一变体（同属性）只有一个字号类，不允许「挂两个同属性工具类」；
//   ④ 关键角色的字号按锚点冻结，className 刻度类与伴随 CSS 子代规则**两处都断言**（见 ROLE_ANCHORS）；
//   ⑤ 迁移完成后目录里只剩登记的关键帧 CSS，且它不含任何选择器规则；
//   ⑥ 分区入场动画的关键帧与引用都在（关键帧无法用工具类表达，是唯一登记的保留项）；
//   ⑦ `AgentFormDialog.tsx` 不再有面板 CSS 的副作用导入；
//   ⑧ 伴随 CSS 里没有「被子孙规则压死的声明」（同选择器同属性，一端 `!important` 一端不带）。
//
// 拦得住：越界字号、同属性双值、分片半删、语义类名回流、锚点角色字号漂移、关键帧丢失，
// 以及下沉时丢掉源类的 `!` 前缀语义（⑧）——后者是真实的踩坑：`className` 里的 `!p-0` 会生成
// `padding:0!important`，改写成 CSS 时漏掉 `!`，声明看起来正常却永远不生效。
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

/**
 * 面板允许的 Tailwind 文字刻度类 → px。
 *
 * 口径在 2026-09 整改后由「一律显式 px 写死」改为「就近取标准档，只允许白名单刻度」
 * （见 `docs/developer/guide/forbidden-code-patterns.md` 的连带影响）。`text-3xs` 是仓库在 `@theme`
 * 自补的 10px 档（`packages/ui-components/web/styles/theme.css`），其余取 Tailwind 默认主题。
 */
const TIER_PX: Record<string, number> = {
  "text-3xs": 10,
  "text-xs": 12,
  "text-sm": 14,
  "text-base": 16,
  "text-lg": 18,
};

/** 任意 Tailwind 文字刻度类（是否在白名单内由 {@link TIER_PX} 判定）；可带变体前缀。 */
const TIER_UTILITY = /(?:^|:)(text-(?:3xs|xs|sm|base|lg|xl|[2-9]xl))$/;

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
 * 目录内样式表**当前真实定义**的类名（读文件而不是查表）。
 *
 * 与 {@link CSS_CLASS_NAMES}（源 CSS 定义过的类名，用于判断「迁移完成了没有」）不同：这里回答的是
 * 「这个类名今天还有没有承载样式的定义」。深层样式下沉（`tmp/phase-b-recipe.md`）让语义类名重新成为
 * 合法载体——类名只要还被某份样式表定义，就不算「迁移残留」，所以 ① 的判据必须按它来收口。
 */
function definedClassNames(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(EDITOR_DIR).filter((name) => name.endsWith(".css"))) {
    const css = readFileSync(join(EDITOR_DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(match[1]);
  }
  return names;
}
const DEFINED_CLASS_NAMES = definedClassNames();

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
 * 关键角色锚点表：`data-slot` 锚点 → 该元素的字号**冻结值**，两处来源分别登记。
 *
 * - `classNameTiers`：元素自身 `className` 必须携带的刻度类（带变体前缀，如 `md:max-2xl:text-base`）。
 *   按整 token 精确比对，不做子串匹配——`text-xs` 与 `text-3xs` 互为近似串，子串匹配会互相误判。
 * - `cssFonts`：伴随 CSS 里以该元素语义类名为根的 `font-size` 声明（选择器原文 + 期望 px + 可选媒体
 *   条件子串）。`media` 省略即要求该声明**不在任何媒体块里**。
 * - `inherits`：元素自身不声明字号、值由继承决定的登记位。它本身不产生断言，只让「这里没有受控字号」
 *   在 review 时可见——这类元素的最终 px 取决于宿主/浏览器默认字号，本仓库未声明，故不冻结数值。
 *
 * 数值口径：字号就近取标准档、接受约 1px 偏差。唯一非刻度值是头部模板按钮窄屏图标化的 `font-size: 0`
 * （0 不能被「就近取档」消化，就近档是 10px——那是 10px 偏差而非 1px，故按原意保留 0）。
 * 锚点名与数值都不允许漂移；`editor-summary-title` 的覆盖区间从 760–1399px 变为 768–1535.98px，
 * 是「任意媒体查询就近落标准断点」的直接结果（`md:max-2xl`）。
 */
const ROLE_ANCHORS: Array<{
  slice: string;
  slot: string;
  note: string;
  classNameTiers?: string[];
  cssFonts?: Array<{ selector: string; px: number; media?: string }>;
  inherits?: true;
}> = [
  { slice: "A2", slot: "editor-title", note: "面板标题", classNameTiers: ["text-sm"] },
  { slice: "A2", slot: "editor-status-pill", note: "运行状态 pill", classNameTiers: ["text-3xs"] },
  { slice: "A2", slot: "editor-subtitle", note: "面板副标题", classNameTiers: ["text-3xs"] },
  { slice: "A2", slot: "editor-map-label", note: "左栏分组标签", classNameTiers: ["text-3xs"] },
  {
    slice: "A2",
    slot: "editor-map-copy",
    note: "左栏条目标题与说明",
    inherits: true,
    cssFonts: [
      { selector: ".agent-editor-map-copy > strong", px: 12 },
      { selector: ".agent-editor-map-copy > small", px: 10 },
    ],
  },
  { slice: "A2", slot: "editor-summary-eyebrow", note: "右栏眉标", classNameTiers: ["text-3xs"] },
  {
    slice: "A2",
    slot: "editor-summary-title",
    note: "右栏标题（768–1535.98px 压 16px）",
    classNameTiers: ["text-lg", "md:max-2xl:text-base"],
  },
  {
    slice: "A2",
    slot: "editor-template-header",
    note: "模板对话框头部（对话框标题 16px）",
    inherits: true,
    // 眉标在本模板对话框里是直接挂在 `<span>` 上的 `EYEBROW` 常量（与右栏共用），由
    // `editor-summary-eyebrow` 锚点锁定，故此处不登记 `> span` 的字号。
    cssFonts: [
      { selector: ".agent-editor-template-header > h2", px: 16 },
      { selector: ".agent-editor-template-header > p", px: 12 },
    ],
  },
  { slice: "A2", slot: "editor-template-empty", note: "模板列表空态", classNameTiers: ["text-3xs"] },
  {
    slice: "A2",
    slot: "editor-mobile-template",
    note: "头部模板按钮（窄屏图标化归 0）",
    inherits: true,
    // 两条同选择器的声明：基础 12px 与窄屏 0。窄屏那条必须带 `!important` 才能压过基础规则，
    // 否则本锚点会「断言通过但实际不生效」——同类死声明由 ⑧ 兜底。
    cssFonts: [
      { selector: ".agent-editor-chrome-template-trigger > button", px: 12 },
      { selector: ".agent-editor-chrome-template-trigger > button", px: 0, media: "(width < 48rem)" },
    ],
  },
  {
    slice: "A2",
    slot: "editor-footer-state",
    note: "页脚状态块",
    inherits: true,
    cssFonts: [
      { selector: ".agent-editor-footer__state span", px: 12 },
      { selector: ".agent-editor-footer__state strong", px: 12 },
      { selector: ".agent-editor-footer__state small", px: 10 },
    ],
  },
  {
    slice: "B",
    slot: "editor-section-intro",
    note: "分区说明块（眉标 10 / 标题 18→16 / 说明 12）",
    inherits: true,
    cssFonts: [
      { selector: ".agent-editor-section__intro > span", px: 10 },
      { selector: ".agent-editor-section__intro > h3", px: 18 },
      { selector: ".agent-editor-section__intro > p", px: 12 },
      { selector: ".agent-editor-section__intro > h3", px: 16, media: "(width >= 48rem) and (width < 96rem)" },
    ],
  },
  { slice: "B", slot: "editor-field-label", note: "字段标签", classNameTiers: ["text-xs"] },
  {
    slice: "C",
    slot: "editor-knowledge-heading",
    note: "知识区块标题与说明",
    inherits: true,
    cssFonts: [
      { selector: ".agent-knowledge-block__heading > div > strong", px: 12 },
      { selector: ".agent-knowledge-block__heading > div > small", px: 10 },
    ],
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

/** 类名 token 里的字号类：白名单刻度类，或任意值 `text-[Npx]`（都可带变体前缀）。 */
function sizeUtilities(className: string): string[] {
  return className
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => /(^|:)text-\[[\d.]+px\]$/.test(token) || TIER_UTILITY.test(token));
}

function readEditorFile(name: string): string {
  return readFileSync(join(EDITOR_DIR, name), "utf8");
}

/** 一条 CSS 声明（值原样保留，判定交给调用方）。 */
interface CssDeclaration {
  file: string;
  /** 所在媒体条件原文；不在任何媒体块里时为 `null`。 */
  media: string | null;
  selector: string;
  property: string;
  value: string;
  important: boolean;
}

/** 归一 CSS 长度到 px：`10px` / `0.75rem`(×16) / `var(--text-3xs, 10px)` 取回退值；`0` 记 0。 */
function toPx(value: string): number | null {
  const text = value.trim();
  if (text === "0") return 0;
  const px = text.match(/^([\d.]+)px$/);
  if (px) return Number(px[1]);
  const rem = text.match(/^([\d.]+)rem$/);
  if (rem) return Number(rem[1]) * 16;
  const fallback = text.match(/^var\([^,]+,\s*([^)]+)\)$/);
  return fallback ? toPx(fallback[1]) : null;
}

/**
 * 解析目录内全部伴随样式表的声明。
 *
 * 为什么守卫要读 CSS：见文件头「两处来源」——下沉后多数受控字号不再以工具类出现在 `className`，
 * 只扫 JSX 的守卫对它们是盲的。解析刻意从简：只认 `@media` 一层下钻（`@keyframes` 里的 `from/to`
 * 不是选择器，进了表只会制造假命中），声明按 `;` 切分。文件都在 20KB 以内，不追求解析性能。
 */
function readCssDeclarations(): CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  for (const file of readdirSync(EDITOR_DIR)
    .filter((name) => name.endsWith(".css"))
    .sort()) {
    walk(file, readEditorFile(file).replace(/\/\*[\s\S]*?\*\//g, ""), null);
  }
  return declarations;

  function walk(file: string, text: string, media: string | null): void {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf("{", index);
      if (open < 0) return;
      // 取 `{` 之前最后一段：顶层可能有 `@import "…";` 直接跟在选择器前面，整段当选择器会切错。
      const rawHead = text.slice(index, open);
      const head = rawHead.slice(rawHead.lastIndexOf(";") + 1).trim();
      const close = closeBrace(text, open);
      if (head.startsWith("@")) {
        if (/^@media\b/.test(head)) walk(file, text.slice(open + 1, close), head.replace(/^@media\s*/, "").trim());
      } else {
        for (const piece of text.slice(open + 1, close).split(";")) {
          const match = piece.match(/^\s*([a-zA-Z-]+)\s*:\s*(.+?)\s*$/);
          if (!match) continue;
          declarations.push({
            file,
            media,
            selector: head,
            property: match[1],
            value: match[2].replace(/!important$/, "").trim(),
            important: /!important$/.test(match[2]),
          });
        }
      }
      index = close + 1;
    }
  }
}

/** `open` 处 `{` 的配对 `}` 下标（CSS 里没有引号包住的括号，直接数层数）。 */
function closeBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return text.length - 1;
}

/**
 * 简写属性 → 它实际写到的分量（只列本目录出现过的简写，不做完整 CSS 展开）。
 * 用途是判断两条声明是否在争同一个分量：`padding` 与 `padding-inline` 重叠，`padding` 与 `color` 不重叠。
 */
const SHORTHAND_COMPONENTS: Record<string, string[]> = {
  font: ["font-size", "font-weight", "font-family", "line-height"],
  padding: ["padding-inline", "padding-block", "padding-top", "padding-right", "padding-bottom", "padding-left"],
  "padding-inline": ["padding-inline-start", "padding-inline-end"],
  "padding-block": ["padding-block-start", "padding-block-end"],
  margin: ["margin-inline", "margin-block", "margin-top", "margin-right", "margin-bottom", "margin-left"],
  "margin-inline": ["margin-inline-start", "margin-inline-end"],
  "margin-block": ["margin-block-start", "margin-block-end"],
  border: ["border-width", "border-color", "border-style", "border-radius"],
  "border-width": ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"],
  "border-color": ["border-top-color", "border-right-color", "border-bottom-color", "border-left-color"],
  gap: ["row-gap", "column-gap"],
  background: ["background-color", "background-image", "background-position", "background-size"],
  overflow: ["overflow-x", "overflow-y"],
};

/** 两个属性是否可能写到同一个分量（简化版：只看一层展开，够覆盖本目录的简写/分量混用）。 */
function sameComponent(left: string, right: string): boolean {
  const parts = new Set([left, ...(SHORTHAND_COMPONENTS[left] ?? [])]);
  return [right, ...(SHORTHAND_COMPONENTS[right] ?? [])].some((part) => parts.has(part));
}

describe("Agent Editor：Tailwind 迁移与字号刻度", () => {
  // 分片必须整片迁移：删了一半的 CSS 会让「哪些声明还生效」变得不可推断，迁移期也必须保持可推理。
  // 语义类名的判据是「今天还有没有样式表定义它」：Web 样式下沉后它们重新成为合法的深层样式载体。
  test("每个分片的 CSS 文件整片删除，且删干净后不再残留无人定义的语义类名", () => {
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
            // 仍被样式表定义的语义类名是合法的下沉载体（见 DEFINED_CLASS_NAMES），不算残留。
            if (DEFINED_CLASS_NAMES.has(token)) continue;
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

  // 口径在 2026-09 整改后由「字号一律显式 px 写死」改为「就近取标准档，只允许白名单刻度」：
  // 越档仍要拦（`text-xl` 这类不在白名单内），任意值 px 则一律不许回流 `className`——窄屏图标化的
  // `0` 已改由伴随 CSS 表达（见 ROLE_ANCHORS 的 `editor-mobile-template`）。
  // 一个文件被多个分片共享（如 `AgentFormDialog.tsx`）时，以「所有列入它的分片都迁完」为门。
  test("面板 JSX 的字号只用白名单刻度，且不出现任意值字号", () => {
    const pending = new Set(SLICES.filter((slice) => !migrated(slice)).flatMap((slice) => [...slice.tsxFiles]));
    const violations: string[] = [];
    for (const file of readdirSync(EDITOR_DIR).filter((name) => name.endsWith(".tsx") && !pending.has(name))) {
      for (const literal of classNameLiterals(readEditorFile(file))) {
        for (const token of literal.split(/\s+/).filter(Boolean)) {
          if (/(^|:)text-\[[\d.]+px\]$/.test(token)) violations.push(`${file} 任意值字号 ${token}`);
          const tier = token.match(TIER_UTILITY);
          if (tier && !(tier[1] in TIER_PX)) violations.push(`${file} 白名单外刻度 ${token}`);
        }
      }
    }
    expect(violations).toEqual([]);
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

  // 关键角色的字号逐个锚点冻结：改刻度类、改伴随 CSS 里的 font-size、删掉区间覆盖、
  // 或让窄屏图标化按钮重新长出文字，都会在这里变红。两处来源都查（见 ROLE_ANCHORS 的字段说明）。
  test("关键角色的字号按锚点冻结（className 刻度类 + 伴随 CSS 两处来源）", () => {
    const declarations = readCssDeclarations();
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
        const tokens = candidate.className.split(/\s+/).filter(Boolean);
        for (const tier of anchor.classNameTiers ?? []) {
          if (!tokens.includes(tier)) {
            missing.push(`${anchor.slot}（${anchor.note}）${candidate.file} 的 className 缺刻度类 ${tier}`);
          }
        }
      }
      for (const expected of anchor.cssFonts ?? []) {
        const hit = declarations.some(
          (declaration) =>
            declaration.selector === expected.selector &&
            declaration.property === "font-size" &&
            toPx(declaration.value) === expected.px &&
            (expected.media === undefined
              ? declaration.media === null
              : (declaration.media ?? "").includes(expected.media)),
        );
        if (!hit) {
          const within = expected.media === undefined ? "（不在任何媒体块里）" : `@ ${expected.media}`;
          missing.push(
            `${anchor.slot}（${anchor.note}）伴随 CSS 缺 ${expected.selector} 的 font-size: ${expected.px}px ${within}`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  // 下沉最容易丢的是源类的 `!` 前缀语义：`className` 里的 `!p-0` 生成 `padding:0!important`，
  // 改写成 CSS 时漏掉 `!`，同一选择器下基础规则的 important 恒胜——那条声明看起来完全正常却永不生效。
  // 真实踩坑：`AgentEditorChrome.css` 的窄屏按钮块 `padding: 0` / `font-size: 10px` 被基础规则的
  // `padding-inline` / `font-size`（均带 `!important`）压死，32px 宽的按钮仍留着 10px 横内边距与 12px 字号。
  // 判据限定「选择器文本完全相同」：同一选择器即同特指度，important 与非 important 之间不存在翻盘。
  test("伴随样式表里没有被子孙规则压死的声明", () => {
    const declarations = readCssDeclarations();
    const dead: string[] = [];
    for (const target of declarations) {
      if (target.important) continue;
      for (const winner of declarations) {
        if (!winner.important || winner === target) continue;
        if (winner.selector !== target.selector) continue;
        if (!sameComponent(winner.property, target.property)) continue;
        const scope = target.media === null ? "基础" : `@media ${target.media}`;
        const winnerScope = winner.media === null ? "基础" : `@media ${winner.media}`;
        dead.push(
          `${target.file} 的 ${scope} \`${target.selector} { ${target.property}: ${target.value} }\` 永远不会生效——` +
            `被 ${winnerScope} 的 \`${winner.property}: ${winner.value} !important\` 压制`,
        );
      }
    }
    expect(dead).toEqual([]);
  });

  // ⑧ 的另一副形态：伴随表的 `!important` 与**同一元素上的 `!` 工具类**争同一属性时，层序反转会让
  // 未分层的那条恒输（未分层 important 优先级最低）。关闭按钮踩过这个雷：基础 `!bg-transparent`
  // 压在 `@layer utilities`，伴随表的 `:hover` 覆盖写在未分层——hover 变色整条失效。
  // 定点冻结而非通用规则：机械判定「工具类 `!` 与 CSS `!important` 是否同属性」需要把 Tailwind 类名
  // 反解成 CSS 属性（`text-slate-500` 与 `text-xs` 同前缀不同属性），误报率高；这里只钉住已踩雷的
  // 一处，其余同类风险靠改样式时的层叠自查（`docs/developer/guide/forbidden-code-patterns.md` 的 02 下沉约定）。
  test("关闭按钮的基础底色/文字色不带 `!`（否则伴随表的 hover 覆盖恒输）", () => {
    const declaration = readEditorFile("AgentEditorChrome.tsx").match(/const CLOSE_BUTTON = (?:"([^"]*)"|`([^`]*)`)/);
    expect(declaration).not.toBeNull();
    const tokens = (declaration?.[1] ?? declaration?.[2] ?? "").split(/\s+/).filter(Boolean);
    expect(tokens.filter((token) => /^!(?:bg|text)-/.test(token))).toEqual([]);
    // 反面条件：伴随表的 `:hover` 覆盖还在。哪天它被删了，上面这条限制就该一并重新评估。
    expect(readEditorFile("AgentEditorChrome.css")).toContain(".agent-editor-chrome-close-button:hover {");
  });

  // 迁移完成后目录里只允许留下登记文件：关键帧 + `.agent-panel-body` 宿主钩子（两者都在文件头写了移除条件），
  // 外加「与源文件同名的伴随样式表」——它们是 Web 样式下沉的合法载体（见 DEFINED_CLASS_NAMES）。
  test("迁移完成后只剩登记的关键帧、宿主钩子与源文件伴随样式表", () => {
    if (!allMigrated) return;
    const sourceNames = new Set(SCAN_FILES.map((file) => file.replace(/\.tsx?$/, "")));
    const remaining = readdirSync(EDITOR_DIR).filter(
      (name) => name.endsWith(".css") && name !== RETAINED_FILE && !sourceNames.has(name.replace(/\.css$/, "")),
    );
    expect(remaining).toEqual([]);

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

  // 分区入场动画：关键帧留在保留文件里，引用随 `SECTION` 的深层样式下沉到伴随样式表（`animation` 简写里含关键帧名）；
  // 两侧缺一都会让分区标题不再淡入。
  test("分区入场动画的关键帧与引用都在", () => {
    if (!allMigrated) return;
    expect(readFileSync(join(EDITOR_DIR, RETAINED_FILE), "utf8")).toContain("@keyframes agent-editor-section-enter");
    const referenced = readdirSync(EDITOR_DIR)
      .filter((name) => name.endsWith(".css") && name !== RETAINED_FILE)
      .some((name) =>
        /animation:[^;]*agent-editor-section-enter/.test(
          readFileSync(join(EDITOR_DIR, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
        ),
      );
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
