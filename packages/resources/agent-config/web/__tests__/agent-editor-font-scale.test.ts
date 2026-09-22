// web/__tests__/agent-editor-font-scale.test.ts
// 「新建Agent」面板（agent-editor 集群）的字号刻度守卫。
//
// 为什么必须静态断言：面板字号全部写在 9 个 CSS 文件里，且分成两层——「基准层」`agent-editor.css`
// 与「设计层」`agent-editor-design / form-fields / form-surfaces / library / knowledge`——同一条规则
// 常在两层各写一次字号，靠 `AgentFormDialog.tsx` 的 import 顺序决定谁生效。漏改一处不会报错，
// 只会在界面上表现为「同一个组件里同一角色的文字大小不一样」（字段标签 12/13 混用、说明文字
// 10/11/12 混用），而没有任何运行时断言能发现它。
//
// 因此这里直接读 CSS 文本（不渲染、不依赖 jsdom），断言七件事：
//   ① 不出现七档刻度之外的字号；
//   ② 同一选择器跨层只保留一个字号（消灭「双值残留」，改导入顺序不会复活旧值）；
//   ③ 每个语义角色只有一个字号（基准层口径）；
//   ④ 加载壳与加载完成态共用同一批声明，不各自长出一套字号；
//   ⑤ 面板 JSX 里的 Tailwind 文字刻度类只有登记的一处且被面板规则覆盖；
//   ⑥ 逐视口求解后，同一视口下每个语义角色仍然只有一个字号（响应式覆盖不得制造同视口双值）；
//   ⑦ 受控文字元素的每一个选择器都自带 font-size 声明，不得靠从 body 继承碰巧得到 16px。
//
// 拦得住：9 个 CSS 文件里新增或遗留的越界字号、跨层双值、同角色多值、同视口多值、
// 加载态分叉、TC 内联刻度、以及清单内受控文字元素被删除/改名后落回继承。
// 拦不住：① 清单外新增的文字元素（新元素必须登记进 TEXT_SELECTORS 才受 ⑦ 保护）；
// ② 运行时动态挂载、面板 CSS 管不到的元素（如 `ui-components` 内部节点、`DialogTitle` 的 text-lg）；
// ③ 断点下「有意缩放」的幅度是否合理（只校验它落回刻度、且同视口同角色同值）；
// ④ 视觉层级是否倒挂（分区标题 22px 高于面板标题 14px 属既有设计，不在刻度守卫口径内）。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EDITOR_DIR = resolve(import.meta.dir, "../pages/agent-panel/agent-editor");
/** 目标刻度：七个语义档位。窄屏图标化的 0 单独登记在 SCALE_EXCEPTIONS。 */
const SCALE = [8, 11, 12, 14, 16, 20, 22];
/** 唯一登记例外：窄屏下模板按钮图标化，文字宽度归零（`agent-editor-responsive.css` 的 759px 断点）。 */
const SCALE_EXCEPTIONS = [
  { selector: ".agent-editor-header .agent-editor-template-button", at: "@media (max-width: 759px)", value: "0" },
];

type FontSizeRule = { file: string; at: string; selector: string; value: string; shorthand: boolean };

/** 按 `AgentFormDialog.tsx` 的 import 顺序读入面板 CSS 文件名，顺序即层叠顺序。 */
function cssFileNames(): string[] {
  const source = readFileSync(join(EDITOR_DIR, "AgentFormDialog.tsx"), "utf8");
  return [...source.matchAll(/^import "\.\/(agent-editor[\w-]*\.css)";$/gm)].map((match) => match[1]);
}

/**
 * 从规则体里取字号：`font-size` 长写优先；没有长写时落到 `font:` 简写上，取其中代表尺寸的长度 token
 * ——眉标走的就是 `font: 750 8px ui-monospace…`，字重 750 在前，因此不能取「第一个数字开头的 token」。
 */
function readSize(body: string): { value: string; shorthand: boolean } | null {
  const longhand = body.match(/font-size:\s*([^;]+);/);
  if (longhand) return { value: longhand[1].trim(), shorthand: false };
  const shorthand = body.match(/font:\s*([^;]+);/);
  const size = shorthand?.[1].split(/\s+/).find((token) => /^\d[\d.]*(px|rem|em|%)$/.test(token));
  return size ? { value: size, shorthand: true } : null;
}

/** 扫描规则体，抽出一条规则的字号；`at` 记录媒体查询前缀，用来区分基准层与断点覆盖。 */
function readFontSizeRules(): FontSizeRule[] {
  const rules: FontSizeRule[] = [];
  for (const file of cssFileNames()) {
    const lines = readFileSync(join(EDITOR_DIR, file), "utf8").split("\n");
    const atStack: string[] = [];
    let pending: string[] = [];
    let current: { file: string; at: string; selector: string } | null = null;
    let body = "";
    for (const raw of lines) {
      const line = raw.replace(/\/\*.*?\*\//g, "").trim();
      if (!line) continue;
      if (current) {
        if (line === "}") {
          const size = readSize(body);
          if (size) rules.push({ ...current, ...size });
          current = null;
          body = "";
          continue;
        }
        body += ` ${line}`;
        continue;
      }
      if (line.endsWith("{")) {
        const head = [...pending, line.slice(0, -1)].join(" ").trim();
        pending = [];
        if (head.startsWith("@")) atStack.push(head);
        else current = { file, at: atStack.join(" "), selector: head };
        continue;
      }
      if (line === "}") {
        if (atStack.length > 0) atStack.pop();
        continue;
      }
      pending.push(line);
    }
  }
  return rules;
}

/** 选择器列表按顶层逗号拆分，`:where(a, b)` 这类函数内的逗号不拆。 */
function splitSelectorGroup(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buffer = "";
  for (const char of selector) {
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    if (char === "," && depth === 0) {
      parts.push(buffer.trim());
      buffer = "";
      continue;
    }
    buffer += char;
  }
  parts.push(buffer.trim());
  return parts.filter(Boolean);
}

/** 归一化选择器文本，避免同一选择器因换行缩进不同被当成两条规则。 */
function normalize(selector: string): string {
  return selector.replace(/\s+/g, " ").trim();
}

/**
 * 去掉一层面板作用域前缀。面板规则一半写成 `.agent-editor-root .a`、一半写成 `.a`，
 * 两者命中的是同一批元素，做「同角色是否同值」的判断时必须折叠成同一个键。
 */
function scopedKey(selector: string): string {
  return normalize(selector)
    .replace(/^\.agent-editor-root\s+/, "")
    .replace(/^:where\([^)]*(?:agent-editor-root|agent-editor-template-picker)[^)]*\)\s*/, "");
}

function valuesOf(rules: FontSizeRule[], selector: string): string[] {
  const target = scopedKey(selector);
  const matched = rules.filter((rule) => splitSelectorGroup(rule.selector).map(scopedKey).includes(target));
  return [...new Set(matched.map((rule) => rule.value))];
}

// 角色表：顺序即判定优先级（先匹配先归类）。每行 = 角色名 + 选择器特征 + 该角色唯一允许的字号。
const ROLES: Array<[string, RegExp, number]> = [
  ["眉标 eyebrow", /section__intro > span|summary-eyebrow|template-picker__header > span/, 8],
  ["面板标题", /agent-editor-header h2/, 14],
  ["对话框标题", /template-picker__header h2/, 20],
  ["分区标题", /section__intro h3|\.agent-editor-summary h3/, 22],
  ["分区说明段", /section__intro p|agent-editor-summary > p|template-picker__header p/, 14],
  ["面板副标题", /agent-editor-header p/, 12],
  ["展示值（当前选择 / 当前模型）", /single-picker-current strong|agent-model-summary strong/, 16],
  ["字段标签", /field__label$|field__label \{|identity-fields label/, 14],
  [
    "表单输入 / 文本域 / 步进器文本",
    /agent-editor-input$|agent-editor-input \{|agent-editor-textarea$|agent-editor-textarea \{|prompt-editor|agent-editor-stepper input/,
    14,
  ],
  ["计数徽标（capability tab 内计数）", /capability-tabs button > span/, 11],
  [
    "徽标与计数 / 状态 pill / 范围标记",
    /title-row em|tabs-trigger"\] > em|search kbd|picker__list em|group-filter button em|knowledge-switch strong em|:where\(button\) > em|owner-card em|template-picker__list span/,
    11,
  ],
  ["导航分组标签", /agent-editor-map-label/, 11],
  [
    "控件内文本（按钮 / tab / chip / 搜索框 / 值 chip / ID 输入）",
    /agent-editor-button|capability-tabs button|chips button|search input|single-picker-toolbar input|agent-id-row :where\(button\)|footer__actions|template-button|group-filter button span|access-preview > div span|agent-id-row \.agent-editor-input/,
    14,
  ],
  [
    "卡片 / 列表项标题",
    /map-copy strong|summary-cards strong|summary-cards button strong|template-picker__list strong|resource-picker__list strong|selected strong|model-options__copy strong|toggle-row__copy strong|runtime-note strong|summary-note strong|owner-card strong|knowledge-block__heading strong|knowledge-switch strong|footer__state strong/,
    14,
  ],
  ["字符标记（头像首字母 / 状态数字）", /owner-card > span|footer__state > span/, 14],
  ["空态 / 错误标题", /agent-editor-state strong/, 14],
  [
    "辅助说明与提示 / 列表项副标题 / 字段小注",
    /save-meta|header p|guidance|picker__list small|selected small|field__label small|model-options__copy small|model-summary (small|p)|toggle-row__copy small|knowledge-switch small|heading small|owner-card (small|p)|runtime-note p|summary-cards (small|em)|summary-note p|summary-safety|single-picker-toolbar > span|single-picker-current|access-preview > strong|footer__state small|readiness|template-picker__list p|template-picker__search p|map-copy small/,
    12,
  ],
  [
    "空态 / 错误 / 只读提示",
    /agent-editor-state p|field-error|agent-editor-readonly|resource-error|validation-summary|picker__list > p|agent-resource-picker__empty/,
    12,
  ],
  ["分页文本", /agent-editor-pagination/, 12],
];
/** 无消费者的死规则（面板 TSX 里查不到类名），只记录不参与角色口径。 */
const DEAD_RULES = /prompt-label span|prompt-field textarea|\.agent-editor-switch-copy/;
/** 窄屏图标化按钮：登记例外的选择器，逐视口求解时摘出，避免污染「控件内文本」角色。 */
const MOBILE_ICON_ONLY = /agent-editor-header \.agent-editor-template-button/;

/**
 * 受控文字元素清单：面板里会渲染文字的元素，每一个都必须自带 font-size 声明，不得靠继承。
 * 清单由 happy-dom 实测 DOM 的元素枚举得出（见本次收口报告），覆盖面板 9 个 CSS 文件里全部文字承载点，
 * 含 `agent-editor-state strong` / `agent-editor-stepper input` / `agent-resource-picker__empty`
 * 这三处曾经落回 body 16px 的裸标签后代选择器。
 */
const TEXT_SELECTORS: Array<[string, string]> = [
  [".agent-editor-header h2", "面板标题 / 加载壳标题"],
  [".agent-editor-header p", "面板副标题"],
  [".agent-editor-title-row em", "运行状态 pill"],
  [".agent-editor-save-meta span", "运行实例标签"],
  [".agent-editor-save-meta small", "保存说明"],
  [".agent-editor-map-label", "导航分组标签"],
  [".agent-editor-map-copy strong", "分区导航标题"],
  [".agent-editor-map-copy small", "分区导航说明"],
  ['.agent-editor-map [data-slot="tabs-trigger"] > em', "分区状态徽标"],
  [".agent-editor-section__intro > span", "分区眉标"],
  [".agent-editor-section__intro h3", "分区标题"],
  [".agent-editor-section__intro p", "分区说明段"],
  [".agent-editor-field__label", "字段标签"],
  [".agent-editor-field__label small", "字段小注"],
  [".agent-editor-input", "表单输入"],
  [".agent-editor-textarea", "表单文本域"],
  [".agent-editor-agent-id-row .agent-editor-input", "Agent ID 等宽输入"],
  [".agent-editor-button", "面板按钮"],
  [".agent-editor-guidance", "Prompt 提示"],
  [".agent-capability-tabs button", "能力 tab"],
  [".agent-capability-tabs button > span", "tab 计数徽标"],
  [".agent-resource-picker__selected strong", "已选计数"],
  [".agent-resource-picker__selected small", "改选提示"],
  [".agent-resource-picker__empty", "选择区空态提示"],
  [".agent-resource-picker__chips button", "已选 chip"],
  [".agent-resource-picker__search input", "资源搜索框"],
  [".agent-resource-picker__search kbd", "搜索结果计数"],
  [".agent-resource-picker__list strong", "资源名"],
  [".agent-resource-picker__list small", "资源说明"],
  [".agent-resource-picker__list em", "资源范围徽标"],
  [".agent-resource-picker__list > p", "列表空态"],
  [".agent-editor-group-filter button span", "来源导航项"],
  [".agent-editor-group-filter button em", "来源计数徽标"],
  [".agent-editor-pagination", "分页文本"],
  [".agent-single-picker-toolbar input", "单选器搜索框"],
  [".agent-single-picker-toolbar > span", "选项计数"],
  [".agent-single-picker-current", "当前选择条"],
  [".agent-single-picker-current strong", "当前选择值"],
  [".agent-model-options__copy strong", "模型 / 节点名"],
  [".agent-model-options__copy small", "模型 / 节点说明"],
  [".agent-model-options > :where(button) > em", "模型成本徽标"],
  [".agent-model-summary small", "当前模型标签"],
  [".agent-model-summary strong", "当前模型值"],
  [".agent-model-summary p", "重启提示"],
  [".agent-editor-toggle-row__copy strong", "开关标题"],
  [".agent-editor-toggle-row__copy small", "开关说明"],
  [".agent-runtime-note strong", "运行便签标题"],
  [".agent-runtime-note p", "运行便签说明"],
  [".agent-owner-card > span", "归属头像首字母"],
  [".agent-owner-card small", "归属标签"],
  [".agent-owner-card strong", "归属组织名"],
  [".agent-owner-card p", "归属说明"],
  [".agent-owner-card em", "所有者徽标"],
  [".agent-access-preview > strong", "可见性标签"],
  [".agent-access-preview > div span", "可见性值 chip"],
  [".agent-knowledge-block__heading strong", "知识区块标题"],
  [".agent-knowledge-block__heading small", "知识区块说明"],
  [".agent-knowledge-switch strong", "记忆开关标题"],
  [".agent-knowledge-switch strong em", "记忆开关徽标"],
  [".agent-knowledge-switch small", "记忆开关说明"],
  [".agent-editor-summary-eyebrow", "汇总眉标"],
  [".agent-editor-summary h3", "汇总标题"],
  [".agent-editor-summary > p", "汇总说明段"],
  [".agent-editor-summary-cards small", "汇总卡标签"],
  [".agent-editor-summary-cards strong", "汇总卡值"],
  [".agent-editor-summary-cards em", "汇总卡 meta"],
  [".agent-editor-summary-note strong", "汇总便签标题"],
  [".agent-editor-summary-note p", "汇总便签正文"],
  [".agent-editor-summary-safety", "安全提示"],
  [".agent-editor-footer__state > span", "页脚状态数字"],
  [".agent-editor-footer__state strong", "页脚状态标题"],
  [".agent-editor-footer__state small", "页脚状态说明"],
  [".agent-editor-readonly", "只读提示条"],
  [".agent-editor-resource-error", "资源失败提示条"],
  [".agent-editor-field-error", "校验错误"],
  [".agent-editor-state strong", "加载失败标题"],
  [".agent-editor-state p", "加载失败详情"],
  [".agent-editor-stepper input", "检索条数输入"],
  [".agent-editor-template-picker__header > span", "对话框眉标"],
  [".agent-editor-template-picker__header h2", "对话框标题"],
  [".agent-editor-template-picker__header p", "对话框描述"],
  [".agent-editor-template-picker__search p", "模板结果计数"],
  [".agent-editor-template-picker__list strong", "模板名"],
  [".agent-editor-template-picker__list p", "模板描述"],
  [".agent-editor-template-picker__list span", "模板技能数"],
  [".agent-editor-template-picker__list > p", "模板空态"],
];

/** 采样视口：覆盖 759/760、1119/1120、1399/1400 三处断点边界与 700px 高断点两侧。 */
const SAMPLE_VIEWPORTS: Array<[number, number]> = [375, 759, 760, 800, 1119, 1120, 1399, 1400, 1920].flatMap((width) =>
  [700, 900].map((height) => [width, height] as [number, number]),
);

/** 面板只使用 min/max-宽高 的简单合取媒体查询；其它写法一律视为不可解析，让守卫显式失败。 */
function readMediaConditions(at: string): Array<{ min: boolean; width: boolean; px: number }> | null {
  const conditions = [...at.matchAll(/\((min|max)-(width|height):\s*(\d+)px\)/g)];
  const consumed = conditions.map((match) => match[0]).join(" and ");
  const expected = at.replace(/^@media\s*/, "").trim();
  if (conditions.length === 0 || consumed.replace(/\s+/g, " ") !== expected.replace(/\s+/g, " ")) return null;
  return conditions.map(([, kind, axis, px]) => ({ min: kind === "min", width: axis === "width", px: Number(px) }));
}

function mediaApplies(at: string, width: number, height: number): boolean {
  if (!at) return true;
  const conditions = readMediaConditions(at);
  if (!conditions) throw new Error(`无法解析的媒体查询：${at}`);
  return conditions.every((condition) => {
    const actual = condition.width ? width : height;
    return condition.min ? actual >= condition.px : actual <= condition.px;
  });
}

/** 同视口求解：同一选择器特指度相同，故加载顺序里最后一条生效。 */
function winningValuesByRole(width: number, height: number): Map<string, Set<string>> {
  const winners = new Map<string, string>();
  for (const rule of readFontSizeRules()) {
    if (!mediaApplies(rule.at, width, height)) continue;
    for (const part of splitSelectorGroup(rule.selector)) {
      if (MOBILE_ICON_ONLY.test(part)) continue;
      winners.set(scopedKey(part), rule.value);
    }
  }
  const byRole = new Map<string, Set<string>>();
  for (const [selector, value] of winners) {
    const role = ROLES.find(([, pattern]) => pattern.test(selector));
    if (!role) continue;
    byRole.set(role[0], new Set([...(byRole.get(role[0]) ?? []), value]));
  }
  return byRole;
}

describe("Agent Editor 字号刻度", () => {
  // 面板只允许使用七档刻度，防止再次出现 9px/10px/13px/17px/18px 这类临时值。
  test("面板 CSS 只使用 8/11/12/14/16/20/22 七档字号", () => {
    const violations = readFontSizeRules()
      .filter((rule) => !SCALE.includes(Number.parseFloat(rule.value)))
      .filter(
        (rule) =>
          !SCALE_EXCEPTIONS.some(
            (exception) =>
              normalize(rule.selector) === exception.selector &&
              rule.at === exception.at &&
              rule.value === exception.value,
          ),
      )
      .map((rule) => `${rule.file} ${rule.selector} = ${rule.value}`);
    expect(violations).toEqual([]);
  });

  // 基准层与设计层对同一选择器只能有一个字号，否则改一次导入顺序就会让旧值复活。
  test("同一选择器在基准层与设计层只保留一个字号", () => {
    const bySelector = new Map<string, Set<string>>();
    for (const rule of readFontSizeRules().filter((item) => !item.at)) {
      for (const part of splitSelectorGroup(rule.selector)) {
        const key = normalize(part);
        bySelector.set(key, new Set([...(bySelector.get(key) ?? []), rule.value]));
      }
    }
    const conflicts = [...bySelector]
      .filter(([, values]) => values.size > 1)
      .map(([selector, values]) => `${selector} = {${[...values].join(", ")}}`);
    expect(conflicts).toEqual([]);
  });

  // 本次修正的核心口径：每个语义角色恰好一个字号，同一组件里不再出现同角色混排。
  // 只校验基准层；媒体查询里的覆盖由「同视口同角色唯一」那条断言把关。
  test("每个语义角色的字号唯一", () => {
    // 选择器特征之间会重叠（如 `knowledge-switch strong` 也命中 `… strong em`），故按表序先匹配先归类。
    const grouped = new Map<string, FontSizeRule[]>();
    const untracked: string[] = [];
    for (const rule of readFontSizeRules()) {
      if (DEAD_RULES.test(rule.selector)) continue;
      const role = ROLES.find(([, pattern]) => pattern.test(rule.selector));
      if (!role) untracked.push(rule.selector);
      else grouped.set(role[0], [...(grouped.get(role[0]) ?? []), rule]);
    }
    expect(untracked).toEqual([]);
    expect(grouped.size).toBe(ROLES.length);

    const conflicts = [...grouped].flatMap(([role, rules]) => {
      const expected = ROLES.find(([name]) => name === role)?.[2];
      return rules
        .filter((rule) => !rule.at && Number.parseFloat(rule.value) !== expected)
        .map((rule) => `${role} 期望 ${expected}px，实际 ${rule.value}（${rule.selector}）`);
    });
    expect(conflicts).toEqual([]);
  });

  // 响应式覆盖不得在同一个视口里给同一角色留下两个字号：760–1399px 曾只把分区标题压到 20px，
  // 而同权重同字距的汇总标题仍是 22px，两个标题并排呈现时大小不一致。
  test("同一采样视口下每个语义角色只有一个字号", () => {
    const unparsable = [
      ...new Set(readFontSizeRules().flatMap((rule) => (rule.at && !readMediaConditions(rule.at) ? [rule.at] : []))),
    ];
    expect(unparsable).toEqual([]);

    const conflicts: string[] = [];
    for (const [width, height] of SAMPLE_VIEWPORTS) {
      for (const [role, values] of winningValuesByRole(width, height)) {
        if (values.size > 1) conflicts.push(`${width}×${height} ${role} = {${[...values].join(", ")}}`);
      }
    }
    expect(conflicts).toEqual([]);
  });

  // 面板根链（`.agent-editor-shell` / `.agent-editor-root`）不声明字号，因此漏声明的文字元素会一路
  // 继承 body 的 16px——那正是面板里唯一落在刻度之外的正文尺寸。清单里的元素必须各自声明。
  test("受控文字元素选择器必须自带字号声明", () => {
    const rules = readFontSizeRules();
    const declared = new Set(rules.flatMap((rule) => splitSelectorGroup(rule.selector).map(scopedKey)));
    const inherited = TEXT_SELECTORS.filter(([selector]) => !declared.has(scopedKey(selector))).map(
      ([selector, note]) => `${selector}（${note}）`,
    );
    expect(inherited).toEqual([]);

    const outOfScale = TEXT_SELECTORS.flatMap(([selector]) =>
      valuesOf(rules, selector)
        .filter((value) => !SCALE.includes(Number.parseFloat(value)))
        .map((value) => `${selector} = ${value}`),
    );
    expect(outOfScale).toEqual([]);
  });

  // 加载壳与加载完成态复用同一批选择器，两侧字号必须完全一致，避免加载态闪一下另一种排版。
  test("加载壳与加载完成态共用选择器且字号一致", () => {
    expect(readFileSync(join(EDITOR_DIR, "agent-editor-loading.css"), "utf8")).not.toContain("font-size");

    const expected: Array<[string, string]> = [
      [".agent-editor-header h2", "14px"],
      [".agent-editor-map-label", "11px"],
      [".agent-editor-map-copy strong", "14px"],
      [".agent-editor-map-copy small", "12px"],
      ['.agent-editor-map [data-slot="tabs-trigger"] > em', "11px"],
      [".agent-editor-save-meta span", "12px"],
      [".agent-editor-save-meta small", "12px"],
    ];
    const rules = readFontSizeRules();
    const mismatched = expected
      .filter(([selector, value]) => {
        const values = valuesOf(rules, selector);
        return values.length !== 1 || values[0] !== value;
      })
      .map(([selector]) => `${selector} 实际 {${valuesOf(rules, selector).join(", ")}}`);
    expect(mismatched).toEqual([]);
  });

  // 字号一律写在面板 CSS 里；JSX 里新增 Tailwind 文字刻度会绕过刻度守卫，故只允许已登记且被覆盖的一处。
  test("面板 JSX 不新增未登记的 Tailwind 文字刻度类", () => {
    const rules = readFontSizeRules();
    const found: string[] = [];
    for (const file of readdirSync(EDITOR_DIR).filter((name) => name.endsWith(".tsx"))) {
      const source = readFileSync(join(EDITOR_DIR, file), "utf8");
      for (const match of source.matchAll(/className="[^"]*"/g)) {
        for (const utility of match[0].matchAll(/\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\b|\btext-\[\d+px\]/g)) {
          found.push(`${file} ${utility[0]}`);
        }
      }
    }
    expect(found).toEqual(["AgentEditorChrome.tsx text-sm"]);
    // 该 `text-sm`(0,1,0) 被面板规则 (0,1,1) 压过，空态文案实际取 12px。
    expect(valuesOf(rules, ".agent-editor-template-picker__list > p")).toEqual(["12px"]);
  });
});
