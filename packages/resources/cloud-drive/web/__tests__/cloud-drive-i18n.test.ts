// web/__tests__/cloud-drive-i18n.test.ts
// 守护 cloud-drive 字典的完整性：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 都能查到。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不会报错；
// 插值写成单花括号 `{var}` 更隐蔽——i18next 把它当字面文本，界面上出现裸露的 `{var}`。
// 这里直接读 JSON（不初始化 i18next），与运行期渲染行为解耦。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/cloudDrive.json"), "utf8")) as Record<
  string,
  unknown
>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/cloudDrive.json"), "utf8")) as Record<
  string,
  unknown
>;

/** 把嵌套字典摊平成点号路径：`upload.uploading`、`errors.unknown`，顶层键保持原样。 */
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

/** `{{name}}` 占位符集合；`{{date}}` 与 `{{name}}` 在同一句里出现时顺序不重要。 */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((match) => match[1]).sort();
}

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

describe("cloud-drive 字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
  });

  // 插值占位符也必须一致：只在一侧写 {{message}} 会让另一门语言丢掉关键上下文。
  test("同一键的插值占位符在两门语言里一致", () => {
    const mismatched = [...enFlat.entries()]
      .filter(([key]) => zhFlat.has(key))
      .map(([key, value]) => {
        const enSlots = placeholders(value);
        const zhSlots = placeholders(zhFlat.get(key) ?? "");
        return JSON.stringify(enSlots) === JSON.stringify(zhSlots) ? null : { key, enSlots, zhSlots };
      })
      .filter(Boolean);
    expect(mismatched).toEqual([]);
  });

  // 源码里写死的键必须在两门语言里都存在；写错 key 只有运行时才回退成字面量。
  test('源码里的 t("key") 都能在两门字典里查到', () => {
    const missing: string[] = [];
    for (const [key, files] of literalKeys) {
      if (!enFlat.has(key)) missing.push(`${key} 缺少 en（${files.join(", ")}）`);
      if (!zhFlat.has(key)) missing.push(`${key} 缺少 zh（${files.join(", ")}）`);
    }
    expect(missing).toEqual([]);
  });

  // 侧栏导航项的文案随 contribution 声明，必须由本包字典持有，否则侧栏回显 key。
  test("侧栏导航键 nav.cloudDrive 存在", () => {
    expect(enFlat.get("nav.cloudDrive")).toBeTruthy();
    expect(zhFlat.get("nav.cloudDrive")).toBeTruthy();
  });

  // 插值必须用 {{var}}：单花括号是 i18next 的字面文本，界面上会裸露出来。
  test("字典不使用单花括号插值", () => {
    const offenders = [...enFlat.entries(), ...zhFlat.entries()]
      .filter(([, value]) => /(?<!\{)\{[A-Za-z0-9_]+\}(?!\})/.test(value))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });
});
