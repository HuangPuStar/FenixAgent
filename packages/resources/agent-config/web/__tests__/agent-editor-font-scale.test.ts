// web/__tests__/agent-editor-font-scale.test.ts
// 「新建Agent」面板（agent-editor 集群）的字号刻度守卫。
//
// 为什么必须静态断言：面板字号全部写在 9 个 CSS 文件里，且分成两层——「基准层」`agent-editor.css`
// 与「设计层」`agent-editor-design / form-fields / form-surfaces / library / knowledge`——同一条规则
// 常在两层各写一次字号，靠 `AgentFormDialog.tsx` 的 import 顺序决定谁生效。漏改一处不会报错，
// 只会在界面上表现为「同一个组件里同一角色的文字大小不一样」（字段标签 12/13 混用、说明文字
// 10/11/12 混用），而没有任何运行时断言能发现它。
//
// 因此这里直接读 CSS 文本（不渲染、不依赖 jsdom），断言四件事：
//   ① 不出现七档刻度之外的字号；
//   ② 同一选择器跨层只保留一个字号（消灭「双值残留」，改导入顺序不会复活旧值）；
//   ③ 每个语义角色只有一个字号（本次修正的核心口径）；
//   ④ 加载壳与加载完成态共用同一批声明，不各自长出一套字号。
//
// 拦得住：9 个 CSS 文件里新增或遗留的越界字号、跨层双值、同角色多值、加载态分叉。
// 拦不住：① 面板未声明、靠继承得到的字号（`.agent-editor-state strong` 的「加载失败」与
// `.agent-editor-stepper input` 承 16px 正文默认值，`agent-resource-picker__empty` 同理）；
// ② ui-components 与宿主样式带来的字号（如 `DialogTitle` 的 text-lg、`.text-sm` 工具类）；
// ③ 断点下「有意缩放」是否合理（只校验它落回刻度，不评价缩放幅度）；
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

type FontSizeRule = { file: string; at: string; selector: string; value: string };

/** 按 `AgentFormDialog.tsx` 的 import 顺序读入面板 CSS 文件名，顺序即层叠顺序。 */
function cssFileNames(): string[] {
  const source = readFileSync(join(EDITOR_DIR, "AgentFormDialog.tsx"), "utf8");
  return [...source.matchAll(/^import "\.\/(agent-editor[\w-]*\.css)";$/gm)].map((match) => match[1]);
}

/** 抽出一条规则里的 font-size；`at` 记录媒体查询前缀，用来区分基准层与断点覆盖。 */
function readFontSizeRules(): FontSizeRule[] {
  const rules: FontSizeRule[] = [];
  for (const file of cssFileNames()) {
    const lines = readFileSync(join(EDITOR_DIR, file), "utf8").split("\n");
    const atStack: string[] = [];
    let pending: string[] = [];
    let current: FontSizeRule | null = null;
    for (const raw of lines) {
      const line = raw.replace(/\/\*.*?\*\//g, "").trim();
      if (!line) continue;
      if (current && line === "}") {
        current = null;
        continue;
      }
      if (line.endsWith("{")) {
        const head = [...pending, line.slice(0, -1)].join(" ").trim();
        pending = [];
        if (head.startsWith("@")) atStack.push(head);
        else {
          current = { file, at: atStack.join(" "), selector: head, value: "" };
          rules.push(current);
        }
        continue;
      }
      if (line === "}") {
        if (atStack.length > 0) atStack.pop();
        else current = null;
        continue;
      }
      if (current) {
        const declaration = line.match(/font-size:\s*([^;]+);/);
        if (declaration) current.value = declaration[1].trim();
        // `font: 750 8px ui-monospace…` 简写同样决定字号，眉标走的是这条路径。
        const shorthand = line.match(/^font:\s*(.*);$/);
        if (shorthand) current.value ||= shorthand[1].split(/\s+/).find((part) => /^\d/.test(part)) ?? "";
      } else pending.push(line);
    }
  }
  return rules.filter((rule) => rule.value);
}

/** 选择器列表按顶层逗号拆分，`：where(a, b)` 这类函数内的逗号不拆。 */
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

function valuesOf(rules: FontSizeRule[], selector: string): string[] {
  const target = normalize(selector);
  return [...new Set(rules.filter((rule) => normalize(rule.selector) === target).map((rule) => rule.value))];
}

// 角色表：顺序即判定优先级（先匹配先归类）。每行 = 角色名 + 选择器特征 + 该角色唯一允许的字号。
const ROLES: Array<[string, RegExp, number]> = [
  ["眉标 eyebrow", /section__intro > span|summary-eyebrow|template-picker__header > span/, 8],
  ["面板标题", /agent-editor-header h2/, 14],
  ["对话框标题", /template-picker__header h2/, 20],
  ["分区标题", /section__intro h3|\.agent-editor-summary h3/, 22],
  ["分区说明段", /section__intro p|agent-editor-summary > p/, 14],
  ["面板副标题", /agent-editor-header p/, 12],
  ["展示值（当前选择 / 当前模型）", /single-picker-current strong|agent-model-summary strong/, 16],
  ["字段标签", /field__label$|field__label \{|identity-fields label/, 14],
  [
    "表单输入 / 文本域文本",
    /agent-editor-input$|agent-editor-input \{|agent-editor-textarea$|agent-editor-textarea \{|prompt-editor/,
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
    "控件内文本（按钮 / tab / chip / 搜索框 / 值 chip）",
    /agent-editor-button|capability-tabs button|chips button|search input|single-picker-toolbar input|agent-id-row :where\(button\)|footer__actions|template-button|group-filter button span|access-preview > div span|agent-id-row \.agent-editor-input/,
    14,
  ],
  [
    "卡片 / 列表项标题",
    /map-copy strong|summary-cards strong|summary-cards button strong|template-picker__list strong|resource-picker__list strong|selected strong|model-options__copy strong|toggle-row__copy strong|runtime-note strong|summary-note strong|owner-card strong|knowledge-block__heading strong|knowledge-switch strong|footer__state strong/,
    14,
  ],
  ["字符标记（头像首字母 / 状态数字）", /owner-card > span|footer__state > span/, 14],
  [
    "辅助说明与提示 / 列表项副标题 / 字段小注",
    /save-meta|header p|guidance|picker__list small|selected small|field__label small|model-options__copy small|model-summary (small|p)|toggle-row__copy small|knowledge-switch small|heading small|owner-card (small|p)|runtime-note p|summary-cards (small|em)|summary-note p|summary-safety|single-picker-toolbar > span|single-picker-current|access-preview > strong|footer__state small|readiness|template-picker__list p|template-picker__header p|template-picker__search p|map-copy small/,
    12,
  ],
  [
    "空态 / 错误 / 只读提示",
    /agent-editor-state p|field-error|agent-editor-readonly|resource-error|validation-summary|picker__list > p/,
    12,
  ],
  ["分页文本", /agent-editor-pagination/, 12],
];
/** 无消费者的死规则（面板 TSX 里查不到类名），只记录不参与角色口径。 */
const DEAD_RULES = /prompt-label span|prompt-field textarea|\.agent-editor-switch-copy/;

/** 加载壳复用了加载完成态的选择器，两侧必须同字号；这里逐条钉住共用选择器的字号。 */
const LOADING_SHELL_SHARED: Array<[string, string]> = [
  [".agent-editor-header h2", "14px"],
  [".agent-editor-map-label", "11px"],
  [".agent-editor-map-copy strong", "14px"],
  [".agent-editor-map-copy small", "12px"],
  ['.agent-editor-map [data-slot="tabs-trigger"] > em', "11px"],
  [".agent-editor-save-meta span", "12px"],
  [".agent-editor-save-meta small", "12px"],
];

/** 面板 JSX 里仅存的一处 Tailwind 文字刻度类，及其被面板规则覆盖的证据（特指度 (0,1,1) > (0,1,0)）。 */
const TAILWIND_TEXT_EXCEPTIONS = [
  { file: "AgentEditorChrome.tsx", className: "text-sm", coveredBy: ".agent-editor-template-picker__list > p" },
];

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
  // 只校验基准层（媒体查询里的「有意缩放」由刻度守卫把关，不按角色期望值判定）。
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

  // 加载壳与加载完成态复用同一批选择器，两侧字号必须完全一致，避免加载态闪一下另一种排版。
  test("加载壳与加载完成态共用选择器且字号一致", () => {
    expect(readFileSync(join(EDITOR_DIR, "agent-editor-loading.css"), "utf8")).not.toContain("font-size");

    const rules = readFontSizeRules();
    const mismatched = LOADING_SHELL_SHARED.filter(([selector, expected]) => {
      const values = valuesOf(rules, selector);
      return values.length !== 1 || values[0] !== expected;
    }).map(([selector, expected]) => `${selector} 期望 ${expected}，实际 {${valuesOf(rules, selector).join(", ")}}`);
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
    expect(found).toEqual(TAILWIND_TEXT_EXCEPTIONS.map((exception) => `${exception.file} ${exception.className}`));
    for (const exception of TAILWIND_TEXT_EXCEPTIONS) {
      expect(valuesOf(rules, exception.coveredBy)).toEqual(["12px"]);
    }
  });
});
