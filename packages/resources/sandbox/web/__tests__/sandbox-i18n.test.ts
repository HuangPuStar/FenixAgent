// web/__tests__/sandbox-i18n.test.ts
// 守护 sandbox 字典的完整性：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 都能查到。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不会报错，
// 只有英文/中文来回切换才会暴露，容易漏到线上。这里直接读 JSON 文件（不经过 i18next 单例），
// 因此不受测试中 react-i18next 模块 mock 影响（宿主测试曾因 mock 让 t() 回显 key）。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/sandbox.json"), "utf8")) as Record<string, unknown>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/sandbox.json"), "utf8")) as Record<string, unknown>;

/** 把嵌套字典摊平成点号路径：`login.title`、`states.loading`，顶层键保持原样。 */
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

/** 源码里出现的全部字面量 `t("key")`（动态键如 t(field.labelKey) 由各自的字面量断言覆盖）。 */
function collectLiteralKeys(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const file of sources) {
    const relPath = relative(WEB_ROOT, file);
    for (const match of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([^"]+)"/g)) {
      usage.set(match[1], [...(usage.get(match[1]) ?? []), relPath]);
    }
  }
  return usage;
}

const literalKeys = collectLiteralKeys();

describe("sandbox 字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(100);
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

  // 源码里所有字面量键都必须存在于字典（扫描有效性自检：至少覆盖到全部页面文件）。
  test("源码中的字面量 t() 键都在字典内", () => {
    const missing = [...literalKeys.keys()].filter((key) => !enFlat.has(key) && !zhFlat.has(key));
    expect(missing).toEqual([]);
    expect(literalKeys.size).toBeGreaterThanOrEqual(60);
  });

  // 已迁出的寄居键不得回流到 observer 命名空间；本包里禁止再出现 `sandbox.` 前缀键。
  test("字典中不存在 sandbox. 前缀的寄居键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("sandbox."));
    expect(nested).toEqual([]);
  });

  // 资源字段表（InstanceDetailDialog 的 RESOURCE_FIELDS）用动态键，单独断言这批键存在。
  test("资源字段与单位键齐备（动态键无法被字面量扫描覆盖）", () => {
    for (const key of [
      "resourceCpu",
      "resourceMemory",
      "resourceDisk",
      "resourceGpu",
      "unitCore",
      "unitMegabyte",
      "unitGigabyte",
      "unitGpu",
      "resourceLabelWithUnit",
    ]) {
      expect(enFlat.has(key)).toBe(true);
      expect(zhFlat.has(key)).toBe(true);
    }
  });
});
