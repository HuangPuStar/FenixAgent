// src/__tests__/chat-channel-browser-surface.test.ts
// 守护 @fenix/chat-channel 根入口的浏览器可达面（2026-08-17 事故回归）。
//
// 事故形态：persist/snapshot-framing.ts 顶层执行 node:crypto 的 randomUUID()，
// 经根 barrel → state/factory → persist/redis 引用链进入前端 bundle；浏览器里
// node:crypto 是 Vite 外置桩，整包 import 期崩溃。build:web 与 Bun 测试均无法
// 暴露（Bun 里 node 内建存在、Vite 对 node: 前缀只外置不报错），因此唯一的
// CI 防线是本测试：静态走根入口的值导入图，断言不触及 node 内建 / ioredis /
// 服务端专属模块。新增服务端模块时禁止从根入口 re-export，应经
// @fenix/chat-channel/server 子路径（CLAUDE.md YJS 不变量 11）。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const PKG_SRC = resolve(import.meta.dir, "../../packages/chat-channel/src");
const ROOT_ENTRY = join(PKG_SRC, "index.ts");

/** state 目录下的服务端专属文件（聚合层 / 持久化工厂）；root 只允许 chat-writer / yjs-store */
const SERVER_STATE_FILES = new Set([
  "aggregator.ts",
  "doc-manager.ts",
  "factory.ts",
  "question.ts",
  "permission.ts",
  "session-list.ts",
  "turn-machine.ts",
]);

/** 包外运行时依赖白名单：新增条目必须同步评估浏览器可用性 */
const EXTERNAL_ALLOWLIST = new Set(["yjs", "acp-link"]);

/** 去掉 // 与块注释（注释文本里可能引用 node:crypto 等字样，必须先剥离再匹配） */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: '"' | "'" | "`" | null = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out += char === "\\" ? "\\" : "";
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      out += char;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

interface Clause {
  /** import/export 子句（default / namespace / named 列表原文），无则视为副作用导入 */
  clause: string | null;
  /** import type / export type 声明，编译期擦除 */
  typeOnly: boolean;
  specifier: string;
}

/** 提取一条语句的模块说明符（import/export ... from "spec" 与副作用 import "spec"） */
function extractStatements(code: string): Clause[] {
  const clauses: Clause[] = [];
  const fromRe = /\b(import|export)\s+(type\s+)?([\s\S]*?)?\s*from\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(fromRe)) {
    clauses.push({ clause: match[3] ?? null, typeOnly: Boolean(match[2]), specifier: match[4] });
  }
  const sideEffectRe = /(?:^|[\s;])import\s*["']([^"']+)["']/gm;
  for (const match of code.matchAll(sideEffectRe)) {
    clauses.push({ clause: null, typeOnly: false, specifier: match[1] });
  }
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of code.matchAll(dynamicRe)) {
    clauses.push({ clause: null, typeOnly: false, specifier: match[1] });
  }
  return clauses;
}

/** 子句是否含值绑定：default / namespace / named 列表中剔除 `type X` 后仍有剩余 */
function hasValueBinding(clause: string | null): boolean {
  if (!clause) return true; // 副作用导入或动态 import：一律按值处理
  const braceMatch = clause.match(/\{([^}]*)\}/);
  if (braceMatch) {
    const values = braceMatch[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !/^type\s/.test(entry));
    if (values.length > 0) return true;
  }
  // `export * from`（子句为裸 `*`）与 `* as ns` 都是值绑定，必须沿图继续走
  const braceless = clause
    .replace(/\{[^}]*\}/g, "")
    .replace(/,/g, " ")
    .trim();
  return braceless.length > 0;
}

/** 相对说明符解析到真实 .ts 文件（裸目录拼 index.ts） */
function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      const stat = candidate.endsWith(".ts");
      if (stat && readFileSync(candidate, "utf8").length >= 0) return candidate;
    }
  }
  return null;
}

interface WalkResult {
  files: string[];
  externals: Array<{ file: string; specifier: string }>;
}

function walkValueGraph(entry: string): WalkResult {
  const visited = new Set<string>([entry]);
  const queue = [entry];
  const externals: Array<{ file: string; specifier: string }> = [];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const statement of extractStatements(code)) {
      if (statement.typeOnly || !hasValueBinding(statement.clause)) continue;
      const resolved = resolveModule(file, statement.specifier);
      if (resolved) {
        if (!visited.has(resolved)) {
          visited.add(resolved);
          queue.push(resolved);
        }
      } else {
        externals.push({ file, specifier: statement.specifier });
      }
    }
  }
  return { files: [...visited], externals };
}

describe("chat-channel 根入口浏览器可达面", () => {
  const graph = walkValueGraph(ROOT_ENTRY);
  const relFiles = graph.files.map((file) => relative(PKG_SRC, file));

  test("不触及 node 内建与 ioredis 运行时导入", () => {
    const offenders = graph.externals.filter(
      (entry) => entry.specifier.startsWith("node:") || entry.specifier === "ioredis",
    );
    expect(offenders.map((entry) => `${relative(PKG_SRC, entry.file)} → ${entry.specifier}`)).toEqual([]);
  });

  test("遍历有效性自检：已知浏览器安全模块在到达集合中（防止走空图假阳性）", () => {
    for (const expected of [
      "index.ts",
      "state/chat-writer.ts",
      "state/yjs-store.ts",
      "transport/ws.ts",
      "protocol/update-frame.ts",
      "schema.ts",
    ]) {
      expect(relFiles).toContain(expected);
    }
    // 根入口值导入图应覆盖浏览器安全面的全部模块，规模过小说明解析失效
    expect(relFiles.length).toBeGreaterThanOrEqual(8);
  });

  test("值导入图不进入服务端专属模块（persist / channel / state 聚合层）", () => {
    const offenders = relFiles.filter((file) => {
      if (file.startsWith("persist/") || file.startsWith("channel/")) return true;
      return file.startsWith("state/") && SERVER_STATE_FILES.has(file.slice("state/".length));
    });
    expect(offenders).toEqual([]);
  });

  test("包外运行时依赖在白名单内（yjs / acp-link）", () => {
    const offenders = graph.externals.filter((entry) => {
      const root = entry.specifier.split("/")[0];
      return !EXTERNAL_ALLOWLIST.has(root);
    });
    expect(offenders.map((entry) => `${relative(PKG_SRC, entry.file)} → ${entry.specifier}`)).toEqual([]);
  });

  test("web vite alias 仍指向根入口（守护对象未漂移）", () => {
    const viteConfig = readFileSync(resolve(import.meta.dir, "../../web/vite.config.ts"), "utf8");
    expect(viteConfig).toContain(
      '"@fenix/chat-channel": path.resolve(__dirname, "../packages/chat-channel/src/index.ts")',
    );
  });

  test("服务端子路径入口存在且含聚合层导出", () => {
    const serverEntry = join(PKG_SRC, "server.ts");
    expect(existsSync(serverEntry)).toBe(true);
    const source = readFileSync(serverEntry, "utf8");
    expect(source).toContain('from "./channel"');
    expect(source).toContain('from "./persist"');
    expect(source).toContain('from "./state"');
  });
});
