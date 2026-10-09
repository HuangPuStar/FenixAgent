// web/__tests__/ui-spec-skill-doc-sync.test.ts
// 声明式 UI Spec 的「SKILL.md 正文内嵌清单 ↔ 代码目录」同步门禁（切片 1 之后的第二道）。
//
// 为什么要再钉一道：SKILL.md 是模型产出 ui-spec 的第一入口，切片 1 之后完整类型清单（类型名、props 字段名、
// 枚举字面量、数值上限）被压进正文，正文因此成了第二份真相。任何一侧漂移都不报错：代码新增了类型/字段而文档
// 没写，模型永远学不会用；文档写错枚举或字段名，模型照写会被 strictObject 拒掉，聊天里只表现为「整块降级成
// 原文」，没有告警。所以这里逐标识符比对，且失败信息要能指出缺了哪一个——不用整篇快照，那是排版一动就红、
// 真缺了名字又说不清的断言。
//
// 与 `ui-spec-catalog-doc-sync.test.ts` 的分工：那份钉 `references/*.md` 的结构契约（三级标题、JSON Schema、
// 限额表、跨字段约束表），本文件钉 SKILL.md 正文的标识符清单，且**不依赖任何标题结构**——正文任意位置出现即算，
// 允许文档并行重写排版。
//
// 清单全部从 `catalog.ts` 派生（`Object.keys` + `z.toJSONSchema(entry.props)` 递归遍历），测试里不放副本，
// 免得又多出第三份真相可漂移。
//
// 文档侧书写契约（改 SKILL.md 前先看这里，判定口径的细节都写在断言里）：
// · 类型名与字段名用行内代码书写：`Stack`、`gap`；字段也接受限定形式 `Table.rows`（字段名仍逐字出现）；
// · 枚举字面量写成 `sm` / "sm" / 'sm' 之一，字面量本身逐字一致；
// · 数值上限要与它约束的类型名或字段名同一条正文行（表格行、列表项、句子都行）；判定按「值 + 同行邻居」做，
//   因此多个字段共享同一个上限值时，正文里一处声明会同时满足它们——要字段级精度就写成表格行（同 catalog.md）；
// · 围栏代码块内的示例 JSON **不算**清单来源：示例是用法演示，不是可检索的清单（否则示例里出现过的 `"md"`、
//   `"muted"` 会让枚举断言空转通过）；
// · 「目录外类型」声明行需同时出现标记词与行内代码写的 PascalCase 名字，见 declaredAbsentTypeNames。
//
// 文档路径以本文件位置锚定仓库根，不假定 process.cwd()。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { uiSpecCatalog } from "../chat/ui-spec/catalog";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SKILL_MD_PATH = join(REPO_ROOT, ".agents", "skills", "ui-spec", "SKILL.md");

/** 读文档：缺失时给出带路径的错误，而不是让 ENOENT 埋在调用栈里。 */
function readDoc(path: string): string {
  if (!existsSync(path)) throw new Error(`缺少提示词文档：${path}`);
  return readFileSync(path, "utf8");
}

const SKILL_MD = readDoc(SKILL_MD_PATH);

/** 行内代码包裹：正文里的标识符按 Markdown 习惯写成 `Name`。 */
function code(token: string): string {
  return `\`${token}\``;
}

/**
 * 取正文行（行号与原文对齐）：围栏代码块整体替换成空行。
 * 为什么必须去掉：示例 JSON 里出现的 `"md"`、`"muted"`、`Table` 只是用法演示，拿它当「清单里写了这个
 * 标识符」会让断言空转通过；清单必须在正文（表格、列表、段落）里可检索。
 */
function proseLines(md: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (!inFence && /^```([^`\s]*)\s*$/.test(line)) {
      inFence = true;
      lines.push("");
      continue;
    }
    if (inFence) {
      if (/^`{3,}\s*$/.test(line)) inFence = false;
      lines.push("");
      continue;
    }
    lines.push(line);
  }
  return lines;
}

const PROSE_LINES = proseLines(SKILL_MD);
const PROSE = PROSE_LINES.join("\n");

// ── 从 catalog.ts 派生清单 ──────────────────────────────────────────────

/** JSON Schema 里属于「上限」的键：下限 `min*` 不是上限，不进这份清单。 */
const UPPER_BOUND_KINDS = [
  ["maxLength", "字符串长度上限"],
  ["maxItems", "条目数上限"],
  ["maximum", "数值上限"],
] as const;

/** 本文件消费的 JSON Schema 子集：只读 properties / items / enum 与三个上限键。 */
interface JsonSchemaNode {
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  enum?: unknown[];
  maxLength?: number;
  maxItems?: number;
  maximum?: number;
}

/** 一条上限事实：值、它约束的路径（如 `Table.rows[]`）与顶层字段名，供正文侧的同行关联判定。 */
interface UpperBound {
  type: string;
  field: string;
  path: string;
  kind: string;
  value: number;
}

interface CatalogFacts {
  typeNames: string[];
  fieldsByType: Map<string, string[]>;
  enumLiteralsByType: Map<string, string[]>;
  upperBounds: UpperBound[];
}

/** 把路径段拼成可读标签：数组层贴在上一段后面（`rows[]`），对象层用点号（`rows[].text`）。 */
function joinPath(segments: readonly string[]): string {
  let label = "";
  for (const segment of segments) {
    label = segment === "[]" ? `${label}[]` : label === "" ? segment : `${label}.${segment}`;
  }
  return label;
}

/**
 * 递归走一遍每个类型的 props JSON Schema，收集字段名（含嵌套对象）、任意深度的 enum 字面量与三个上限键。
 * 派生而非抄写：catalog.ts 改了 schema，这里的期望值跟着变，测试才有可能红在该红的地方。
 */
function collectCatalogFacts(): CatalogFacts {
  const catalog = uiSpecCatalog as unknown as Record<string, { props: z.ZodType }>;
  const fieldsByType = new Map<string, string[]>();
  const enumLiteralsByType = new Map<string, string[]>();
  const upperBounds: UpperBound[] = [];

  const walk = (node: JsonSchemaNode, type: string, path: readonly string[]): void => {
    const literals = enumLiteralsByType.get(type) ?? [];
    for (const literal of node.enum ?? []) {
      const text = String(literal);
      if (!literals.includes(text)) literals.push(text);
    }
    enumLiteralsByType.set(type, literals);

    for (const [key, kind] of UPPER_BOUND_KINDS) {
      const value = node[key];
      if (typeof value !== "number") continue;
      upperBounds.push({
        type,
        field: path[0] ?? "",
        path: path.length === 0 ? type : `${type}.${joinPath(path)}`,
        kind,
        value,
      });
    }

    for (const [name, child] of Object.entries(node.properties ?? {})) {
      const fields = fieldsByType.get(type) ?? [];
      if (!fields.includes(name)) fields.push(name);
      fieldsByType.set(type, fields);
      walk(child, type, [...path, name]);
    }
    if (node.items) walk(node.items, type, [...path, "[]"]);
  };

  for (const [type, entry] of Object.entries(catalog)) {
    fieldsByType.set(type, fieldsByType.get(type) ?? []);
    enumLiteralsByType.set(type, enumLiteralsByType.get(type) ?? []);
    walk(z.toJSONSchema(entry.props) as JsonSchemaNode, type, []);
  }

  return { typeNames: Object.keys(catalog), fieldsByType, enumLiteralsByType, upperBounds };
}

const FACTS = collectCatalogFacts();

// ── 正文侧的判定口径 ────────────────────────────────────────────────────

/**
 * 断言 items 的每一项都能在正文里查得到；失败时一次列出**全部**缺失项与判定口径。
 * 为什么不是逐个 `expect(...).toContain(...)`：那样只能看到第一个缺口，文档 owner 改一轮跑一轮；
 * 为什么不是整篇快照：排版微调就红，且失败信息里看不出到底缺了哪个标识符。
 */
function expectAllFound<T>(
  items: readonly T[],
  label: (item: T) => string,
  scope: string,
  contract: string,
  found: (item: T) => boolean,
): void {
  const missing = items.filter((item) => !found(item)).map(label);
  expect(missing, `${scope}：${missing.join("、")}｜判定口径：${contract}`).toEqual([]);
}

/** 同行关联判定：类型名/字段名带行内代码（`Table`）或作为普通词出现（表格单元格、自然句）都算。 */
function mentionsToken(line: string, token: string): boolean {
  if (token === "") return false;
  if (line.includes(code(token))) return true;
  return new RegExp(`(^|[^A-Za-z0-9_])${token}([^A-Za-z0-9_]|$)`).test(line);
}

/** 数字写法容错：允许千位分隔（`2000` / `2,000` / `2_000`），但不接受成为更长数字的一部分（`12000` 里没有 `2000`）。 */
function numberPattern(value: number): RegExp {
  const body = String(value)
    .split("")
    .map((digit, index) => (index === 0 ? digit : `[,_]?${digit}`))
    .join("");
  return new RegExp(`(^|[^0-9])${body}([^0-9]|$)`);
}

/** 「目录外」声明的标记词：同行同时出现标记词与行内代码写的 PascalCase 名字，即视为声明该类型不存在。 */
const ABSENCE_MARKERS = ["目录外", "不在", "没有", "不支持", "未收录", "不可用", "禁止", "不存在", "占位"] as const;

/** 例外措辞：`X` 之外 / 除 `X` 以外 是在讲「除了 X」，不是在把 X 声明为不存在。 */
const EXCLUSION_ESCAPES = ["之外", "以外"] as const;

/**
 * 解析正文里「声明为不存在」的类型名（PascalCase 才收，避免把 `columns` 这类字段名当成类型）。
 * 声明形态不做硬性规定，但必须让标记词与该名字同行——这是能稳定解析、又不会把普通叙述误当清单的写法。
 */
function declaredAbsentTypeNames(lines: readonly string[]): string[] {
  const names = new Set<string>();
  for (const line of lines) {
    if (EXCLUSION_ESCAPES.some((wording) => line.includes(wording))) continue;
    if (!ABSENCE_MARKERS.some((marker) => line.includes(marker))) continue;
    for (const match of line.matchAll(/`([A-Z][A-Za-z0-9]*)`/g)) names.add(match[1] as string);
  }
  return [...names].sort();
}

// ── 断言 ────────────────────────────────────────────────────────────────

describe("ui-spec SKILL.md 正文清单 ↔ catalog.ts（标识符同步）", () => {
  // 守卫自检：catalog.ts 换写法（例如 props 不再是 strictObject、导出不再可枚举）会让派生清单变空，后面的断言
  // 就会全部空转通过——先在入口处把它钉住，保证「没有缺口」是真的没有缺口。
  test("从 catalog.ts 派生的清单非空，守卫不空转", () => {
    const empty: string[] = [];
    if (FACTS.typeNames.length === 0) empty.push("类型名");
    if (FACTS.upperBounds.length === 0) empty.push("数值上限");
    for (const type of FACTS.typeNames) {
      if ((FACTS.fieldsByType.get(type) ?? []).length === 0) empty.push(`${type} 的 props 字段`);
      if ((FACTS.enumLiteralsByType.get(type) ?? []).length === 0) empty.push(`${type} 的枚举字面量`);
    }
    expect(
      empty,
      "派生清单为空通常是 catalog.ts 的导出或 schema 写法变了：请同步本文件的派生逻辑，否则后面的断言会整体空转",
    ).toEqual([]);
  });

  // 类型名是模型挑组件的唯一入口：正文漏一个名字，模型就永远写不出这个类型（写出别的名字只会拿到「不支持的
  // 组件类型」占位），而这在聊天里不报错，没人会发现。
  test("SKILL.md 正文列出了目录里的每个类型名", () => {
    expectAllFound(
      FACTS.typeNames,
      (name) => name,
      "正文缺少目录里的类型名",
      "类型名以行内代码书写，如 `Stack`（围栏内的示例不算）",
      (name) => PROSE.includes(code(name)),
    );
  });

  // 字段名比类型名更容易漏：漏掉 `gap`/`align`，模型只会写出缺字段或多字段的 props，被 strictObject 判 invalid-props。
  test("SKILL.md 正文列出了每个类型的全部 props 字段名", () => {
    const fields = FACTS.typeNames.flatMap((type) =>
      (FACTS.fieldsByType.get(type) ?? []).map((field) => ({ type, field })),
    );
    expectAllFound(
      fields,
      ({ type, field }) => `${type}.${field}`,
      "正文缺少 props 字段名",
      "裸字段 `gap` 或限定形式 `Table.rows` 都算出现（字段名仍须逐字一致）",
      ({ type, field }) => PROSE.includes(code(field)) || PROSE.includes(code(`${type}.${field}`)),
    );
  });

  // 枚举字面量错一个字母（把 `muted` 记成 `dim`）该元素直接 invalid-props 变占位：字面量比类型名更需要逐字钉住。
  test("SKILL.md 正文列出了全部枚举字面量", () => {
    const literals = FACTS.typeNames.flatMap((type) =>
      (FACTS.enumLiteralsByType.get(type) ?? []).map((literal) => ({ type, literal })),
    );
    expectAllFound(
      literals,
      ({ type, literal }) => `${type}.${literal}`,
      "正文缺少枚举字面量",
      '写成 `sm` 或 "sm" 之一，字面量本身逐字一致',
      ({ literal }) =>
        PROSE.includes(code(literal)) || PROSE.includes(`"${literal}"`) || PROSE.includes(`'${literal}'`),
    );
  });

  // 上限只活在数字里：文档漏了上限，模型就会产出超长文本或超宽表格，整块降级成原文，且没有任何提示。
  test("SKILL.md 正文写明了数值上限，且与它约束的类型或字段同行", () => {
    expectAllFound(
      FACTS.upperBounds,
      (bound) => `${bound.path}（${bound.kind}）=${bound.value}`,
      "正文缺少数值上限，或上限没有和它约束的类型/字段同行",
      "上限数字与所属类型名或字段名出现在同一条正文行（表格行、列表项、句子都行；围栏内的示例不算）",
      (bound) =>
        PROSE_LINES.some(
          (line) =>
            numberPattern(bound.value).test(line) &&
            (mentionsToken(line, bound.type) || mentionsToken(line, bound.field)),
        ),
    );
  });
});

describe("ui-spec SKILL.md 正文的「目录外类型」声明 ↔ catalog.ts（黑名单同步）", () => {
  // 正文承诺「这些名字拿不到渲染」，就必须与目录保持一致：目录一旦真的收录其中之一，这句承诺就反过来误导模型。
  test("SKILL.md 声明为目录外的类型都不在目录里", () => {
    const declared = declaredAbsentTypeNames(PROSE_LINES);
    expectAllFound(
      declared,
      (name) => name,
      "「目录外类型」声明与目录冲突（这些名字已经是 catalog.ts 的目录类型）",
      "正文声明目录外或不可用的类型名，必须确实不在 catalog.ts 里",
      (name) => !Object.hasOwn(uiSpecCatalog, name),
    );
  });

  // 上一条的覆盖面靠「正文里真有黑名单」撑着：正文若把这句话删光，断言会因为集合为空而静默通过。
  test("SKILL.md 至少声明了一个目录外类型名（黑名单解析不空转）", () => {
    const declared = declaredAbsentTypeNames(PROSE_LINES);
    expect(
      declared.length,
      "正文解析不出任何「目录外类型」声明：请保留这句声明，或同步 declaredAbsentTypeNames 的标记词与写法假设",
    ).toBeGreaterThan(0);
  });

  // 解析黑名单依赖书写形态，所以这一条是它的静态半场：切片 1 只承诺收录 Stack/Text/Table，常见误用名必须始终不在
  // 目录里；目录一旦收录其中之一，正文里「这些名字只能得到占位符」的说法与本测试的冻结承诺会一起失败。
  test("切片 1 的常见误用类型名确实未被目录声明", () => {
    const misleading = ["Chart", "Kpi", "Grid", "Heading", "Link", "Image", "Progress", "Timeline", "Diff"];
    expectAllFound(
      misleading,
      (name) => name,
      "catalog.ts 收录了本应属于目录外的类型（请同步 SKILL.md 的承诺与本测试的冻结名单）",
      "切片 1 的目录只有 Stack / Text / Table，以下名字必须始终不是目录类型",
      (name) => !Object.hasOwn(uiSpecCatalog, name),
    );
  });
});
