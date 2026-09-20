// web/__tests__/skill-i18n.test.ts
// 守护 skill 字典的完整性：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 都能查到、
// 动态拼接的键族齐备，以及「键与字典都留在本包、只经 `./web/i18n` 出口交付」这一归属约束。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不会报错，
// 只有英文/中文来回切换才会暴露，容易漏到线上。这里直接读 JSON 文件（不经过 i18next 单例），
// 因此不受测试中 react-i18next 模块 mock 影响（宿主测试曾因 mock 让 t() 回显 key）。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/skills.json"), "utf8")) as Record<string, unknown>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/skills.json"), "utf8")) as Record<string, unknown>;
/**
 * 字典文件是本包文案的物理落点，路径漂移会让 `i18n/index.ts` 的 import 解析失败（启动期即崩）。
 *
 * 宿主不再按深相对路径读这两个文件：`apps/web/src/i18n/index.ts:22` 经 `@fenix/resource-skill/web/i18n`
 * 取 `SKILL_NS` + `skillResources`，所以这里钉的是**包内出口契约**，不是宿主路径。
 */
const JSON_PATHS = ["i18n/locales/en/skills.json", "i18n/locales/zh/skills.json"] as const;

/** 把嵌套字典摊平成点号路径：`form.name`、`toast.saveFailed`，顶层键保持原样。 */
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

/** 源码里出现的全部字面量 `t("key")`（动态键如 t(`form.${name}`) 由下面的键族断言覆盖）。 */
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

describe("skill 字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(90);
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

  // 动态键族无法被字面量扫描覆盖，逐个键族点名断言：漏一个就是界面上多出一串 key。
  test("动态键族齐备（表单校验提示）", () => {
    // agent-skills-utils 的 SkillFormValidationErrorKey 联合类型的两个成员
    for (const key of ["form.nameRequired", "form.contentRequired"]) {
      expect(enFlat.has(key)).toBe(true);
      expect(zhFlat.has(key)).toBe(true);
    }
  });

  // 角标键（resource.internal / public / external）属于 components 命名空间，不是本包的键：
  // getSkillResourceBadgeKey 只产出键名，取值由消费方在 NS.COMPONENTS 下解析（当前字典仍在宿主
  // apps/web/src/i18n/locales/<lng>/components.json）。本包字典不得私自复制一份，否则同一句话
  // 会有两个 owner，改一处另一处静默变成旧文案。
  test("字典中不存在 resource.* 角标键（归属 components 命名空间）", () => {
    const borrowed = [...enFlat.keys()].filter((key) => key.startsWith("resource."));
    expect(borrowed).toEqual([]);
  });

  // 键的最终所在地 = 包的 owner：skill 的键注册在 `skills` 命名空间，不得出现寄居在其他命名空间的
  // 前缀（如 `skill.` / `skills.`），否则宿主对不上命名空间。
  test("字典中不存在带命名空间前缀的寄居键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("skills.") || key.startsWith("skill."));
    expect(nested).toEqual([]);
  });

  // 字典路径是本包 `web/i18n/index.ts` 的 import 契约（宿主已改为经 `./web/i18n` 出口取符号，
  // 见文件头的 JSON_PATHS 说明）：迁移只允许增删键、不允许改路径，出口必须指向同一批文件。
  test("字典路径未变，且 web/i18n 出口指向同一批 JSON", () => {
    const entrySource = readFileSync(join(WEB_ROOT, "i18n/index.ts"), "utf8");
    for (const path of JSON_PATHS) {
      expect(statSync(join(WEB_ROOT, path)).isFile()).toBe(true);
      expect(entrySource).toContain(`./locales/${path.split("/").slice(2).join("/")}`);
    }
    expect(entrySource).not.toContain("../src/");
  });

  // 命名空间常量由本包声明（键归属本包）；宿主 `NS.SKILLS` 与这里的字面量必须同值。
  test("命名空间常量与字典文件名一致", () => {
    const namespaceSource = readFileSync(join(WEB_ROOT, "i18n/namespace.ts"), "utf8");
    expect(namespaceSource).toContain('export const SKILL_NS = "skills"');
    const entrySource = readFileSync(join(WEB_ROOT, "i18n/index.ts"), "utf8");
    expect(entrySource).toContain("skillResources");
  });
});
