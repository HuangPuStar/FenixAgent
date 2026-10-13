// web/__tests__/ui-spec-catalog-doc-sync.test.ts
// 声明式 UI Spec 的「代码目录 ↔ 提示词文档」同步门禁（切片 1）。
//
// 为什么要双向且到字段级：目录是给模型看的产物。代码改了文档没改，模型就会产出被拒绝的 Spec，
// 而拒绝路径在聊天里只表现为「整块降级成原文」，不报错、不告警，没人会发现；反过来，文档里写了
// 代码没有的类型或字段，模型照写必错。所以这里不用子串查找、不让 Set 去重掩盖重复标题，而是逐类型
// 逐字段比对，并让文档里的每个示例都真跑一遍 parse / resolve。
//
// 文档侧的格式契约也写在三份文档的 HTML 注释里（改文档格式前先看两边）：
// · catalog.md 的 `### ` 三级标题只用于类型，标题即类型名，每个类型恰好一次；
// · 每个类型段内有且仅有一个 ```json 围栏，是其 props 的 JSON Schema（zod → z.toJSONSchema，省略 $schema）；
// · 每个类型段内的 `- **必填**：` 行列出全部必填字段（无则写 `无`）；
// · examples.md 的 ```ui-spec 围栏是完整合法 Spec，```ui-spec-invalid 的上一非空行声明 `预期：<reason>`。
//
// 文档路径以本文件位置锚定仓库根，不假定 process.cwd()。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod/v4";
import { uiSpecCatalog } from "../chat/ui-spec/catalog";
import { parseUISpec, resolveElement } from "../chat/ui-spec/parse";
import { UI_SPEC_LIMITS } from "../chat/ui-spec/spec";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SKILL_DIR = join(REPO_ROOT, ".agents", "skills", "ui-spec");
const SKILL_MD_PATH = join(SKILL_DIR, "SKILL.md");
const CATALOG_MD_PATH = join(SKILL_DIR, "references", "catalog.md");
const EXAMPLES_MD_PATH = join(SKILL_DIR, "references", "examples.md");

/** 读文档：缺失时给出带路径的错误，而不是让 ENOENT 埋在调用栈里。 */
function readDoc(path: string): string {
  if (!existsSync(path)) throw new Error(`缺少提示词文档：${path}`);
  return readFileSync(path, "utf8");
}

const SKILL_MD = readDoc(SKILL_MD_PATH);
const CATALOG_MD = readDoc(CATALOG_MD_PATH);
const EXAMPLES_MD = readDoc(EXAMPLES_MD_PATH);

/** catalog 条目：本测试只消费 props（zod schema），container 之类由 registry 测试负责。 */
type CatalogEntry = { props: Parameters<typeof z.toJSONSchema>[0] };
const CATALOG = uiSpecCatalog as unknown as Record<string, CatalogEntry>;
const TYPE_NAMES = Object.keys(CATALOG);

// ── Markdown 解析小工具（只服务本文件） ──────────────────────────────────

interface MdSection {
  level: number;
  heading: string;
  body: string;
}

/** 按 ATX 标题切片：每遇到一个标题就开新段，段体到下一个任意级别的标题为止。 */
function splitByHeading(md: string): MdSection[] {
  const sections: MdSection[] = [];
  let current: { level: number; heading: string; lines: string[] } | null = null;
  for (const line of md.split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (current) sections.push({ level: current.level, heading: current.heading, body: current.lines.join("\n") });
      current = { level: (match[1] as string).length, heading: match[2] as string, lines: [] };
      continue;
    }
    current?.lines.push(line);
  }
  if (current) sections.push({ level: current.level, heading: current.heading, body: current.lines.join("\n") });
  return sections;
}

interface MdFence {
  language: string;
  body: string;
  line: number;
}

/**
 * 提取围栏块。开栏必须是行首的三个反引号（语言标记精确匹配，`ui-spec-invalid` 因此不会被当成 `ui-spec`），
 * 闭栏接受三个及以上反引号。
 */
function extractFences(md: string): MdFence[] {
  const lines = md.split("\n");
  const fences: MdFence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const open = /^```([^`\s]*)\s*$/.exec(lines[index] ?? "");
    if (!open) continue;
    const body: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (/^`{3,}\s*$/.test(lines[cursor] ?? "")) break;
      body.push(lines[cursor] as string);
    }
    fences.push({ language: open[1] ?? "", body: body.join("\n").trim(), line: index + 1 });
    index = cursor;
  }
  return fences;
}

/** 解析 Markdown 表格：丢掉表头与分隔行，返回每行的单元格文本。 */
function tableRows(section: string): string[][] {
  const rows = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  const [, separator, ...body] = rows;
  return separator ? body : [];
}

/** 只解析本项目 Skill frontmatter 用到的 `key: value` 行：不为一处断言引入 YAML 依赖。 */
function parseFrontmatter(md: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(md);
  const fields: Record<string, string> = {};
  if (!block) return fields;
  for (const line of (block[1] ?? "").split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match) fields[match[1] as string] = (match[2] as string).trim();
  }
  return fields;
}

/** 取数组第 index 项；越界的错误信息比 undefined 更有用。 */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`期望第 ${index} 项存在，实际长度 ${list.length}`);
  return value;
}

/** 递归剔除非契约键（zod 的 `$schema` 只是注解，不属于 props 契约）。 */
function stripNonContractKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNonContractKeys);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "$schema");
    return Object.fromEntries(entries.map(([key, item]) => [key, stripNonContractKeys(item)]));
  }
  return value;
}

/** 断言 Spec 合法并返回它；失败信息带上实际结果，便于定位坏的是哪一段示例。 */
function expectParseOk(code: string) {
  const result = parseUISpec(code);
  if (result.status !== "ok") throw new Error(`期望合法 Spec，实际 ${result.status}: ${result.reason}`);
  return result.spec;
}

/** 逐个 resolve 解析后的元素，按插入顺序返回 status。 */
function resolveStatuses(spec: ReturnType<typeof expectParseOk>): string[] {
  return Object.values(spec.elements).map((element) => resolveElement(element).status);
}

// ── 文档里约定好的结构 ──────────────────────────────────────────────────

const CATALOG_SECTIONS = splitByHeading(CATALOG_MD);
const TYPE_SECTIONS = CATALOG_SECTIONS.filter((section) => section.level === 3);
const DOC_TYPE_NAMES = TYPE_SECTIONS.map((section) => section.heading);
const ALL_TYPE_NAMES = [...new Set([...TYPE_NAMES, ...DOC_TYPE_NAMES])].sort();
const SECTION_OF = new Map(TYPE_SECTIONS.map((section) => [section.heading, section.body]));

function requireSection(name: string): string {
  const body = SECTION_OF.get(name);
  if (body === undefined) throw new Error(`catalog.md 缺少类型段：### ${name}`);
  return body;
}

function requireEntry(name: string): CatalogEntry {
  const entry = CATALOG[name];
  if (!entry) throw new Error(`catalog.ts 缺少类型：${name}`);
  return entry;
}

/** 取某个 `## ` 小节的正文；标题按包含匹配，避免措辞微调就找不到小节。 */
function h2Section(md: string, keyword: string): string {
  const section = splitByHeading(md).find((item) => item.level === 2 && item.heading.includes(keyword));
  if (!section) throw new Error(`文档缺少小节：## ...${keyword}...`);
  return section.body;
}

const EXAMPLES = extractFences(EXAMPLES_MD).filter((fence) => fence.language === "ui-spec");
const INVALID_EXAMPLES = extractFences(EXAMPLES_MD).filter((fence) => fence.language === "ui-spec-invalid");

describe("ui-spec 提示词资产：文件与 frontmatter", () => {
  // Skill 目录名、frontmatter 的 name 与内置同步落库用的名字必须一致：改名会让升级变成新装一个 Skill。
  test("SKILL.md frontmatter 的 name 与目录同名且 description 非空", () => {
    const frontmatter = parseFrontmatter(SKILL_MD);
    expect(frontmatter.name).toBe(basename(SKILL_DIR));
    expect(frontmatter.name).toMatch(/^[a-z0-9-]+$/);
    expect((frontmatter.description ?? "").length).toBeGreaterThan(0);
    expect(SKILL_MD).toContain("ui-spec");
  });

  // 文档里写到的 references 路径必须真实存在，且 SKILL.md 两份都要引到，否则 Agent 读不到目录只剩猜测。
  test("文档引用的 references 文件都存在，且 SKILL.md 两份都引了", () => {
    const referenced = new Set<string>();
    for (const md of [SKILL_MD, CATALOG_MD, EXAMPLES_MD]) {
      for (const match of md.matchAll(/references\/[A-Za-z0-9._-]+\.md/g)) referenced.add(match[0]);
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const relativePath of referenced) {
      expect(existsSync(join(SKILL_DIR, relativePath))).toBe(true);
    }
    expect(SKILL_MD).toContain("references/catalog.md");
    expect(SKILL_MD).toContain("references/examples.md");
  });
});

describe("ui-spec 提示词资产：类型清单双向同步", () => {
  // 重复标题不能靠 Set 去重掩盖：同名段落出现两次时，后一段的字段声明可能与前一段冲突。
  test("catalog.md 的标题不重复", () => {
    const headings = CATALOG_SECTIONS.map((section) => section.heading);
    expect(headings.length).toBeGreaterThan(0);
    expect([...new Set(headings)].length).toBe(headings.length);
    expect([...new Set(DOC_TYPE_NAMES)].length).toBe(DOC_TYPE_NAMES.length);
  });

  // 双向相等：代码里的每个类型在 catalog.md 有且仅有一个 `### TypeName`，文档里的类型也都在代码里。
  test("catalog.md 的类型标题与 catalog.ts 的类型集合双向相等", () => {
    expect(DOC_TYPE_NAMES.length).toBe(TYPE_NAMES.length);
    expect([...DOC_TYPE_NAMES].sort()).toEqual([...TYPE_NAMES].sort());
  });

  // SKILL.md 的「可用类型」清单是模型第一眼看到的东西，必须与 catalog 完全同集，不能多也不能少。
  test("SKILL.md 的可用类型清单与 catalog.ts 的类型集合同步", () => {
    const section = splitByHeading(SKILL_MD).find((item) => item.level === 2 && item.heading.includes("可用类型"));
    expect(section).toBeDefined();
    const listed = [...(section?.body ?? "").matchAll(/^-\s+`([A-Za-z][A-Za-z0-9]*)`\s*[-—:：]/gm)].map(
      (match) => match[1] as string,
    );
    expect(listed.length).toBe(TYPE_NAMES.length);
    expect([...listed].sort()).toEqual([...TYPE_NAMES].sort());
  });
});

describe("ui-spec 提示词资产：props 级同步", () => {
  for (const name of ALL_TYPE_NAMES) {
    // 每个类型段唯一那个 json 围栏必须是该 props 的 JSON Schema，且与 catalog.ts 的 zod schema 逐字段一致。
    test(`catalog.md 里 ${name} 的 props JSON Schema 与 catalog.ts 一致`, () => {
      const fences = extractFences(requireSection(name));
      expect(fences.map((fence) => fence.language)).toEqual(["json"]);
      const documented = JSON.parse(at(fences, 0).body) as Record<string, unknown>;
      const actual = stripNonContractKeys(z.toJSONSchema(requireEntry(name).props)) as Record<string, unknown>;
      expect(documented).toEqual(actual);
      expect(documented.type).toBe("object");
      expect(documented.additionalProperties).toBe(false);
    });
  }

  for (const name of ALL_TYPE_NAMES) {
    // 字段名、必填、枚举都要在文档里查得到：模型只读文档，缺一项就会写出被拒的 Spec。
    test(`catalog.md 里 ${name} 的字段名、必填与枚举与 catalog.ts 一致`, () => {
      const section = requireSection(name);
      const schema = stripNonContractKeys(z.toJSONSchema(requireEntry(name).props)) as {
        properties?: Record<string, { enum?: unknown[] }>;
        required?: string[];
      };
      const properties = Object.entries(schema.properties ?? {});
      expect(properties.length).toBeGreaterThan(0);
      for (const [property, definition] of properties) {
        expect(section).toContain(`\`${property}\``);
        for (const value of definition.enum ?? []) {
          expect(section).toContain(`"${String(value)}"`);
        }
      }
      const requiredLine = section.split("\n").find((line) => line.startsWith("- **必填**："));
      expect(requiredLine).toBeDefined();
      const declared = [...(requiredLine ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
      expect(declared.sort()).toEqual([...(schema.required ?? [])].sort());
    });
  }

  // 全局限额表是「什么时候整块降级」的唯一说明，键集与数值都必须与 spec.ts 的 UI_SPEC_LIMITS 完全一致。
  test("catalog.md 的全局限额表与 UI_SPEC_LIMITS 一致", () => {
    const documented = Object.fromEntries(
      tableRows(h2Section(CATALOG_MD, "全局限额")).map((cells) => [
        at(cells, 0).replace(/`/g, ""),
        Number(at(cells, 2).replace(/[,_\s]/g, "")),
      ]),
    );
    expect(documented).toEqual({ ...UI_SPEC_LIMITS });
  });

  // 跨字段约束表按规则 ID 冻结：文档改了规则，这里的 ID、关键字段与违反结果会一起失败，逼人同步。
  test("catalog.md 的跨字段约束表与冻结规则一致", () => {
    const rows = tableRows(h2Section(CATALOG_MD, "跨字段约束"));
    const frozen = [
      { id: "CT-1", mentions: ["rows", "columns"], verdict: "invalid-props" },
      { id: "CT-2", mentions: ["align", "columns"], verdict: "invalid-props" },
      { id: "CT-3", mentions: ["gap", "tone", "align"], verdict: "默认" },
    ] as const;
    expect(rows.length).toBe(frozen.length);
    for (const [index, rule] of frozen.entries()) {
      const cells = at(rows, index);
      expect(at(cells, 0)).toBe(rule.id);
      for (const mention of rule.mentions) expect(at(cells, 1)).toContain(mention);
      expect(at(cells, 2)).toContain(rule.verdict);
    }
  });
});

describe("ui-spec 目录边界与跨字段约束（行为）", () => {
  // 正例：行数、列数与 align 长度都对齐时，元素必须能正常 resolve，且数据原样进入结果。
  test("Table 行列等长且 align 等长时正常 resolve", () => {
    const rows = [
      ["上海", "1,284"],
      ["杭州", "906"],
    ];
    const spec = expectParseOk(
      JSON.stringify({
        version: 1,
        root: "t",
        elements: { t: { type: "Table", props: { columns: ["城市", "订单量"], rows, align: ["left", "right"] } } },
      }),
    );
    const element = at(Object.values(spec.elements), 0);
    const resolution = resolveElement(element);
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") throw new Error("unreachable");
    expect(resolution.props.rows).toEqual(rows);
  });

  // 默认值也是文档对 Agent 的承诺（CT-3）：省略 gap / tone / align 时必须先归一，再交给组件渲染。
  test("省略 gap、tone、align 时按 CT-3 的默认值归一", () => {
    const spec = expectParseOk(
      JSON.stringify({
        version: 1,
        root: "root",
        elements: {
          root: { type: "Stack", children: ["note", "orders"] },
          note: { type: "Text", props: { text: "正常" } },
          orders: { type: "Table", props: { columns: ["城市", "订单量"], rows: [["上海", "1"]] } },
        },
      }),
    );
    const resolutions = Object.values(spec.elements).map((element) => resolveElement(element));
    const stack = at(resolutions, 0);
    const text = at(resolutions, 1);
    const table = at(resolutions, 2);
    if (stack.status !== "ok" || text.status !== "ok" || table.status !== "ok") {
      throw new Error(`三个元素都应解析成功，实际 ${resolutions.map((item) => item.status).join(",")}`);
    }
    expect(stack.props).toEqual({ gap: "md" });
    expect(text.props).toEqual({ text: "正常", tone: "default" });
    expect(table.props).toEqual({ columns: ["城市", "订单量"], rows: [["上海", "1"]], align: ["left", "left"] });
  });

  // 反例：某一行缺列（或多列）时，该元素按 invalid-props 占位，兄弟元素继续渲染，不整块崩掉。
  test("Table 某行长度不等于列数时该元素 invalid-props，兄弟元素继续渲染", () => {
    const spec = expectParseOk(
      JSON.stringify({
        version: 1,
        root: "root",
        elements: {
          root: { type: "Stack", children: ["ok", "bad"] },
          ok: { type: "Text", props: { text: "正常" } },
          bad: { type: "Table", props: { columns: ["城市", "订单量"], rows: [["上海", "1,284"], ["杭州"]] } },
        },
      }),
    );
    expect(resolveStatuses(spec)).toEqual(["ok", "ok", "invalid-props"]);
  });

  // 反例：align 长度不等于列数时同样按元素失效处理，不静默补齐或截断。
  test("Table 的 align 长度不等于列数时该元素 invalid-props", () => {
    const spec = expectParseOk(
      JSON.stringify({
        version: 1,
        root: "t",
        elements: {
          t: { type: "Table", props: { columns: ["城市", "订单量"], rows: [["上海", "1"]], align: ["left"] } },
        },
      }),
    );
    expect(resolveStatuses(spec)).toEqual(["invalid-props"]);
  });

  // 反例：空 rows 是非法输入而不是「空状态」——没有数据应当由 Agent 改用文字，而不是交一张空表。
  test("Table 的 rows 为空数组时该元素 invalid-props", () => {
    const spec = expectParseOk(
      JSON.stringify({
        version: 1,
        root: "t",
        elements: { t: { type: "Table", props: { columns: ["城市"], rows: [] } } },
      }),
    );
    expect(resolveStatuses(spec)).toEqual(["invalid-props"]);
  });

  // 反例：多写一个目录外字段（例如样式）就是无效元素——模型不能借额外字段控制视觉或注入能力。
  test("props 多写目录外字段时该元素 invalid-props", () => {
    const spec = expectParseOk(
      JSON.stringify({
        version: 1,
        root: "t",
        elements: { t: { type: "Text", props: { text: "正常", className: "text-red" } } },
      }),
    );
    expect(resolveStatuses(spec)).toEqual(["invalid-props"]);
  });

  // 反例：目录外类型只占位、不渲染其子树，兄弟元素照常渲染；原型键名不能绕过目录检查。
  test("目录外类型 unsupported 且兄弟元素继续渲染", () => {
    const spec = expectParseOk(
      JSON.stringify({
        version: 1,
        root: "root",
        elements: {
          root: { type: "Stack", children: ["ok", "chart", "proto"] },
          ok: { type: "Text", props: { text: "正常" } },
          chart: { type: "Chart", props: { series: [1, 2, 3] } },
          proto: { type: "constructor", props: {} },
        },
      }),
    );
    expect(resolveStatuses(spec)).toEqual(["ok", "ok", "unsupported", "unsupported"]);
  });

  const STRUCTURE_NEGATIVES = [
    // 缺 root 字段
    { name: "缺 root", code: '{"version":1,"elements":{"a":{"type":"Text","props":{"text":"x"}}}}' },
    // root 指向不存在的元素
    {
      name: "root 指向不存在的元素",
      code: '{"version":1,"root":"missing","elements":{"a":{"type":"Text","props":{"text":"x"}}}}',
    },
    // 顶层多写字段
    {
      name: "顶层多写字段",
      code: '{"version":1,"root":"a","elements":{"a":{"type":"Text","props":{"text":"x"}}},"title":"报告"}',
    },
    // 元素额外字段
    {
      name: "元素多写字段",
      code: '{"version":1,"root":"a","elements":{"a":{"type":"Text","props":{"text":"x"},"style":{"color":"red"}}}}',
    },
    // 存在不可达元素
    {
      name: "存在不可达元素",
      code: '{"version":1,"root":"a","elements":{"a":{"type":"Text","props":{"text":"x"}},"b":{"type":"Text","props":{"text":"y"}}}}',
    },
    // 引用成环
    {
      name: "引用成环",
      code: '{"version":1,"root":"a","elements":{"a":{"type":"Stack","children":["b"]},"b":{"type":"Stack","children":["a"]}}}',
    },
    // 一个元素被两个父元素引用
    {
      name: "多父共享",
      code: '{"version":1,"root":"a","elements":{"a":{"type":"Stack","children":["b","c"]},"b":{"type":"Stack","children":["d"]},"c":{"type":"Stack","children":["d"]},"d":{"type":"Text","props":{"text":"x"}}}}',
    },
    // 叶子节点带 children
    {
      name: "叶子节点带 children",
      code: '{"version":1,"root":"a","elements":{"a":{"type":"Text","props":{"text":"x"},"children":["b"]},"b":{"type":"Text","props":{"text":"y"}}}}',
    },
  ];

  // 结构非法一律整块降级为原文（不局部剪裁成看似成功的 UI），原因为 structure。
  test.each(STRUCTURE_NEGATIVES)("结构非法：$name → degraded:structure", ({ code }) => {
    const result = parseUISpec(code);
    expect(result.status).toBe("degraded");
    if (result.status === "degraded") expect(result.reason).toBe("structure");
  });

  // 版本不在支持范围内时整块降级并提示版本，不假装按当前版本渲染。
  test("version 非 1 时 degraded:version", () => {
    const result = parseUISpec('{"version":2,"root":"a","elements":{"a":{"type":"Text","props":{"text":"x"}}}}');
    expect(result.status).toBe("degraded");
    if (result.status === "degraded") expect(result.reason).toBe("version");
  });

  // JSON 本身不合法（尾逗号、注释）时 degraded:json，不尝试修补或猜测。
  test("JSON 语法错误时 degraded:json", () => {
    const result = parseUISpec('{"version":1,"root":"a","elements":{"a":{"type":"Text","props":{"text":"x"}},}}');
    expect(result.status).toBe("degraded");
    if (result.status === "degraded") expect(result.reason).toBe("json");
  });

  // 超限额（元素 id 超 80 字符、单个字符串超 2000 字符）时 degraded:limits，不截断成貌似完整的 UI。
  test("超出 id 与字符串限额时 degraded:limits", () => {
    const longId = `id_${"x".repeat(78)}`;
    expect(longId.length).toBeGreaterThan(80);
    const overId = JSON.stringify({
      version: 1,
      root: longId,
      elements: { [longId]: { type: "Text", props: { text: "示例" } } },
    });
    const overString = JSON.stringify({
      version: 1,
      root: "a",
      elements: { a: { type: "Text", props: { text: "字".repeat(2001) } } },
    });
    for (const code of [overId, overString]) {
      const result = parseUISpec(code);
      expect(result.status).toBe("degraded");
      if (result.status === "degraded") expect(result.reason).toBe("limits");
    }
  });
});

describe("ui-spec 示例文档", () => {
  // 示例是 Agent 最可能照抄的东西：每个 ui-spec 围栏都要能解析，且每个元素都能 resolve 成功。
  test("examples.md 的 ui-spec 示例都合法且元素全部可 resolve", () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(3);
    for (const fence of EXAMPLES) {
      const spec = expectParseOk(fence.body);
      expect(resolveStatuses(spec).filter((status) => status !== "ok")).toEqual([]);
    }
    expect(EXAMPLES.some((fence) => /[\u4e00-\u9fff]/u.test(fence.body))).toBe(true);
  });

  // 示例必须体现「数据内联、不发请求」：出现 fetch、URL、脚本或 $ 绑定就说明规则没落到实处。
  test("examples.md 的示例不含 fetch、URL、脚本与 $ 绑定", () => {
    for (const fence of EXAMPLES) {
      expect(fence.body).not.toContain("fetch(");
      expect(fence.body).not.toContain("<script");
      expect(fence.body).not.toContain("{{");
      expect(fence.body).not.toMatch(/https?:\/\//);
      expect(fence.body).not.toMatch(/"\$[A-Za-z]/);
    }
  });

  // 反例必须声明预期结果：声明与实际不符时，文档在教模型写错东西（或是实现漏了这条校验）。
  test("examples.md 的反例都声明了预期且与实际一致", () => {
    expect(INVALID_EXAMPLES.length).toBeGreaterThan(0);
    const lines = EXAMPLES_MD.split("\n");
    for (const fence of INVALID_EXAMPLES) {
      let declared = "";
      for (let index = fence.line - 2; index >= 0; index -= 1) {
        const text = (lines[index] ?? "").trim();
        if (text !== "") {
          declared = text;
          break;
        }
      }
      const reason = declared.replace(/^预期：/, "");
      expect(declared).toStartWith("预期：");
      if (reason === "json" || reason === "structure" || reason === "version" || reason === "limits") {
        const result = parseUISpec(fence.body);
        expect(result.status).toBe("degraded");
        if (result.status === "degraded") expect(result.reason).toBe(reason);
        continue;
      }
      expect(["unsupported", "invalid-props"]).toContain(reason);
      const spec = expectParseOk(fence.body);
      expect(resolveStatuses(spec).filter((status) => status !== "ok")).toEqual([reason]);
    }
  });
});

describe("ui-spec SKILL.md 正文", () => {
  // SKILL.md 里的示例也会被照抄，所以同样要真跑一遍；它同时是「怎么产围栏」的唯一说明。
  test("SKILL.md 的 ui-spec 示例合法且元素全部可 resolve", () => {
    const fences = extractFences(SKILL_MD).filter((fence) => fence.language === "ui-spec");
    expect(fences.length).toBeGreaterThan(0);
    for (const fence of fences) {
      const spec = expectParseOk(fence.body);
      expect(resolveStatuses(spec).filter((status) => status !== "ok")).toEqual([]);
    }
  });

  // 设计文档 §2.3 的 authoring rules 必须逐条落在提示词里，否则「只产数据、不发请求」只是口头约定。
  test("SKILL.md 写明了硬要求与 authoring rules", () => {
    for (const phrase of [
      "只产数据",
      "不写代码",
      "不发请求",
      "数据内联",
      "一次输出一个完整的",
      "拿不准",
      "空状态",
      "坐标轴与单位",
      "来源与时间范围",
      "同构卡片",
    ]) {
      expect(SKILL_MD).toContain(phrase);
    }
  });
});
