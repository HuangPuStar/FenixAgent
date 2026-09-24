// web/__tests__/knowledge-i18n.test.ts
// 守护 knowledge 字典的完整性：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 都能查到。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不会报错，
// 只有中英文来回切换才会暴露。这里直接读 JSON 文件（不经过 i18next 单例），
// 因此不受 react-i18next 模块 mock 影响。
//
// 键归属（本次迁移的实测结论，2026-09-20）：字典 56 个顶层键 / 247 个叶子键，两语言键集一致；
// `packages/resources/observer/web/i18n/{en,zh}/observer.json` 里既没有 `knowledge*` 顶层键，
// 也没有任何含 "knowledge"/"知识库" 的字面量（两语言各 0 处匹配）——因此没有「寄居键迁出」
// 动作，本文件用「不得出现 knowledge./observer. 前缀键」锁住这条结论（寄居键回流会命中）。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/knowledge.json"), "utf8")) as Record<
  string,
  unknown
>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/knowledge.json"), "utf8")) as Record<
  string,
  unknown
>;

/** 把嵌套字典摊平成点号路径：`btn.create`、`directory.title`，顶层键保持原样。 */
function flatten(source: Record<string, unknown>, prefix = ""): Map<string, string> {
  const flat = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of flatten(value as Record<string, unknown>, path)) {
        flat.set(nestedKey, nestedValue);
      }
    } else {
      flat.set(path, String(value));
    }
  }
  return flat;
}

/** 递归收集 web 下的 .ts/.tsx 源码（排除测试与字典自身）。 */
function collectSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "__tests__" || entry === "locales") continue;
      files.push(...collectSources(path));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

const sources = collectSources(WEB_ROOT);
const enFlat = flatten(EN);
const zhFlat = flatten(ZH);

/** 源码里出现的字面量 `t("key")`；`ns:key` 形态是显式跨命名空间引用，不算本字典的键。 */
function collectLiteralKeys(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const file of sources) {
    const relPath = relative(WEB_ROOT, file);
    for (const match of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([^"]+)"/g)) {
      if (match[1].includes(":")) continue;
      usage.set(match[1], [...(usage.get(match[1]) ?? []), relPath]);
    }
  }
  return usage;
}

const literalKeys = collectLiteralKeys();

describe("knowledge 字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(200);
  });

  // 插值占位符必须成对出现，否则某一语言会显示 {{var}} 字面量。
  test("en / zh 同一键的插值占位符一致", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    const mismatched = [...enFlat.keys()].filter(
      (key) =>
        JSON.stringify(placeholders(enFlat.get(key) ?? "")) !== JSON.stringify(placeholders(zhFlat.get(key) ?? "")),
    );
    expect(mismatched).toEqual([]);
  });

  // 源码里所有字面量键都必须存在于字典（159 个字面量键，扫描有效性自检防「扫到 0 个也绿」）。
  test("源码中的字面量 t() 键都在字典内", () => {
    const missing = [...literalKeys.keys()].filter((key) => !enFlat.has(key) && !zhFlat.has(key));
    expect(missing).toEqual([]);
    expect(literalKeys.size).toBeGreaterThanOrEqual(145);
  });

  // 寄居键回流会同时命中两个前缀：本包键不进 `knowledge.` 子树，也不留在 observer 命名空间下。
  test("字典中不存在 knowledge. / observer. 前缀的寄居键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("knowledge.") || key.startsWith("observer."));
    expect(nested).toEqual([]);
  });

  // 资源状态与预览类型表用动态键拼装，单独断言这批键存在（字面量扫描覆盖不到）。
  test("状态与预览分类键齐备（动态键无法被字面量扫描覆盖）", () => {
    for (const key of ["status.pending", "status.processing", "status.ready", "status.error"]) {
      expect(enFlat.has(key)).toBe(true);
      expect(zhFlat.has(key)).toBe(true);
    }
  });

  // 检索测试的跨语言选项按后端语言名拼键（`retrieval.languages.${value}`，值来自
  // CROSS_LANGUAGE_VALUES 的 10 个英文名）：漏一个界面上就会露出键名，且字面量扫描同样覆盖不到。
  test("检索面板的 10 个语言名键齐备", () => {
    for (const language of [
      "English",
      "Chinese",
      "Spanish",
      "French",
      "German",
      "Japanese",
      "Korean",
      "Vietnamese",
      "Arabic",
      "Turkish",
    ]) {
      expect(enFlat.has(`retrieval.languages.${language}`), `en 缺 retrieval.languages.${language}`).toBe(true);
      expect(zhFlat.has(`retrieval.languages.${language}`), `zh 缺 retrieval.languages.${language}`).toBe(true);
    }
  });
});
