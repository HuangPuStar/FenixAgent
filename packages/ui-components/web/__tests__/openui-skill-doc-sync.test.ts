// 内置 openui 技能与 SDK 组件目录的同步门禁。
//
// 为什么需要它：技能文档是模型看到的唯一组件说明，SDK 升级后 spec.json 与文档漂移不会报错，
// 只会让模型写出解析失败的程序，聊天里表现为整段回退成代码块。这里按组件名与必填参数双向比对，
// 并让示例围栏的第一条语句、组件集合与变量可达性都受约束。
//
// 文档侧的格式契约（改格式前先看测试）：
// · catalog.md 的 `### ` 三级标题只用于组件，标题即组件名，每个组件恰好一次；
// · 每个组件段落的正文（签名行除外）必须提到该组件全部必填参数名；
// · examples.md 的每个 ```openui 围栏都是完整程序，第一条语句以 `root = Stack(` 开头。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OPENUI_ARTIFACT } from "@peri-code/sdk/openui/prompt";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const SKILL_DIR = join(REPO_ROOT, ".agents", "skills", "openui");
const SKILL_MD_PATH = join(SKILL_DIR, "SKILL.md");
const CATALOG_MD_PATH = join(SKILL_DIR, "references", "catalog.md");
const EXAMPLES_MD_PATH = join(SKILL_DIR, "references", "examples.md");
const LEGACY_SKILL_DIR = join(REPO_ROOT, ".agents", "skills", "ui-spec");

/** 缺文档时抛出带路径的错误，避免 ENOENT 埋在调用栈里。 */
function readDoc(path: string): string {
  if (!existsSync(path)) throw new Error(`缺少 openui 技能文档：${path}`);
  return readFileSync(path, "utf8");
}

const SKILL_MD = readDoc(SKILL_MD_PATH);
const CATALOG_MD = readDoc(CATALOG_MD_PATH);
const EXAMPLES_MD = readDoc(EXAMPLES_MD_PATH);

interface ComponentSpec {
  readonly signature: string;
  readonly description: string;
}

const COMPONENTS = OPENUI_ARTIFACT.spec.components as Record<string, ComponentSpec>;
const COMPONENT_NAMES = Object.keys(COMPONENTS).sort();

// ── Markdown 解析小工具（只服务本文件） ────────────────────────────────

/** 按 `### <Name>` 切片；遇到更高级别标题即结束当前组件段。 */
function extractComponentSections(md: string): Map<string, string> {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (current !== null) sections.set(current, body.join("\n"));
  };
  for (const line of md.split("\n")) {
    const heading = /^###[ \t]+([A-Za-z][A-Za-z0-9]*)[ \t]*$/.exec(line);
    if (heading) {
      flush();
      current = heading[1];
      body = [];
      continue;
    }
    if (/^#{1,2}[ \t]+/.test(line)) {
      flush();
      current = null;
      body = [];
      continue;
    }
    if (current !== null) body.push(line);
  }
  flush();
  return sections;
}

/** 按顶层逗号切分形参；括号、数组、对象与字符串内部的逗号不切。 */
function splitTopLevelParams(signature: string): string[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  if (open < 0 || close < open) throw new Error(`无法解析签名：${signature}`);
  const params: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = "";
  for (const ch of signature.slice(open + 1, close)) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      current += ch;
      continue;
    }
    if (!inString) {
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      else if (ch === "," && depth === 0) {
        params.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim() !== "") params.push(current.trim());
  return params;
}

/** 必填形参名：`name: type` 且 name 后没有 `?`。 */
function requiredParamNames(signature: string): string[] {
  return splitTopLevelParams(signature).flatMap((param) => {
    const match = /^([A-Za-z_$][\w$]*)\s*(\?)?\s*:/.exec(param);
    return match && match[2] !== "?" ? [match[1]] : [];
  });
}

/** 去掉签名行后的正文：签名本身包含全部形参名，留在正文里会让断言失去意义。 */
function proseWithoutSignature(section: string): string {
  return section
    .split("\n")
    .filter((line) => !/^`[A-Z][A-Za-z0-9]*\(.*\)`$/.test(line.trim()))
    .join("\n");
}

/** 围栏内的组件调用名；排除 `@ToAssistant(` / `@OpenUrl(` 这类动作。 */
function extractComponentCalls(program: string): string[] {
  const names = new Set<string>();
  for (const match of program.matchAll(/(?<![\w@])([A-Z][A-Za-z0-9]*)\(/g)) names.add(match[1]);
  return [...names].sort();
}

/** 从文档里抽取 `Name(args...)` 形式的完整签名，键为组件名。 */
function extractSignatures(md: string, pattern: RegExp): Map<string, string> {
  const signatures = new Map<string, string>();
  for (const match of md.matchAll(pattern)) signatures.set(match[1], `${match[1]}(${match[2].trim()})`);
  return signatures;
}

const CATALOG_SIGNATURES = extractSignatures(CATALOG_MD, /^`([A-Z][A-Za-z0-9]*)\((.*)\)`$/gm);
const SKILL_SIGNATURES = extractSignatures(SKILL_MD, /^- `([A-Z][A-Za-z0-9]*)\((.*)\)` —/gm);

// ── 测试 ────────────────────────────────────────────────────────────────

describe("openui 技能文档同步", () => {
  // 组件标题集合必须与 SDK spec 完全一致：缺组件会让模型不知道能力，多组件会让模型写出不存在的类型。
  test("catalog.md 的 ### 标题集合与 spec.json 组件集合完全相等", () => {
    const documented = [...CATALOG_MD.matchAll(/^###[ \t]+([A-Za-z][A-Za-z0-9]*)[ \t]*$/gm)]
      .map((match) => match[1])
      .sort();
    const documentedSet = new Set(documented);
    const missing = COMPONENT_NAMES.filter((name) => !documentedSet.has(name));
    const extra = [...documentedSet].filter((name) => !COMPONENT_NAMES.includes(name));
    const duplicates = documented.filter((name, index) => index > 0 && documented[index - 1] === name);
    expect(
      { missing, extra, duplicates },
      `catalog.md 与 spec.json 不一致：缺少 [${missing.join(", ")}]，多出 [${extra.join(", ")}]，重复 [${duplicates.join(", ")}]`,
    ).toEqual({ missing: [], extra: [], duplicates: [] });
    expect(documented).toEqual(COMPONENT_NAMES);
  });

  // 签名是模型确定参数顺序的唯一依据：与 spec.json 逐字不一致会直接生成解析失败的程序。
  test("SKILL.md 与 catalog.md 的组件签名与 spec.json 逐字一致", () => {
    const failures: string[] = [];
    for (const [name, component] of Object.entries(COMPONENTS)) {
      for (const [label, signatures] of [
        ["SKILL.md", SKILL_SIGNATURES],
        ["catalog.md", CATALOG_SIGNATURES],
      ] as const) {
        const actual = signatures.get(name);
        if (actual === undefined) failures.push(`${label}: 缺少 ${name} 的签名`);
        else if (actual !== component.signature) {
          failures.push(`${label}: ${name} 签名不一致\n  期望 ${component.signature}\n  实际 ${actual}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // 每个组件的必填参数都必须在正文里出现，避免模型只看到组件名却不知道必填项。
  test("每个组件的必填参数名都出现在其 catalog.md 段落正文中", () => {
    const sections = extractComponentSections(CATALOG_MD);
    const failures: string[] = [];
    for (const name of COMPONENT_NAMES) {
      const section = sections.get(name);
      if (section === undefined) {
        failures.push(`${name}: 缺少段落`);
        continue;
      }
      const prose = proseWithoutSignature(section);
      for (const param of requiredParamNames(COMPONENTS[name].signature)) {
        if (!new RegExp(`\\b${param}\\b`).test(prose)) failures.push(`${name}: 正文缺少必填参数 ${param}`);
      }
    }
    expect(failures).toEqual([]);
  });

  // 技能必须把围栏名、根语句与两种动作写给模型，否则模型不知道如何输出可渲染的程序。
  test("SKILL.md 声明了围栏名、root 语句与动作语法", () => {
    for (const needle of ["openui", "root = Stack(", "@ToAssistant", "@OpenUrl"]) {
      expect(SKILL_MD, `SKILL.md 缺少 ${needle}`).toContain(needle);
    }
  });

  // 旧技能目录必须已删除：保留它会继续向 Agent 投放 ui-spec JSON 契约。
  test("旧 ui-spec 技能目录不存在", () => {
    expect(existsSync(LEGACY_SKILL_DIR)).toBe(false);
  });

  // 示例必须可直接渲染：首条语句固定 root，组件名受 32 个目录约束，除 root 外变量都要被引用。
  test("examples.md 的每个 openui 围栏都是完整可达程序", () => {
    const programs = [...EXAMPLES_MD.matchAll(/```openui[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
    expect(programs.length).toBeGreaterThanOrEqual(6);

    const failures: string[] = [];
    programs.forEach((program, index) => {
      const label = `示例 ${index + 1}`;
      const firstStatement = program.split("\n")[0]?.trim() ?? "";
      if (!firstStatement.startsWith("root = Stack(")) {
        failures.push(`${label}: 第一条语句不是 root = Stack(（实际：${firstStatement}）`);
      }
      for (const used of extractComponentCalls(program)) {
        if (!COMPONENT_NAMES.includes(used)) failures.push(`${label}: 使用了目录外组件 ${used}`);
      }
      const lines = program.split("\n");
      const defined = new Set<string>();
      for (const line of lines) {
        const match = /^([a-z][A-Za-z0-9_]*)\s*=/.exec(line);
        if (match) defined.add(match[1]);
      }
      for (const variable of defined) {
        if (variable === "root") continue;
        const definitionPattern = new RegExp(`^\\s*${variable}\\s*=`);
        const referencePattern = new RegExp(`\\b${variable}\\b`);
        const referenced = lines.some((line) => !definitionPattern.test(line) && referencePattern.test(line));
        if (!referenced) failures.push(`${label}: 变量 ${variable} 定义后未被引用`);
      }
    });
    expect(failures).toEqual([]);
  });
});
