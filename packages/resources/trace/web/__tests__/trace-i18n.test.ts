// web/__tests__/trace-i18n.test.ts
// 守护 trace 字典的完整性与自持性（键的最终所在地 = 包的 owner）。
//
// i18next 缺键时只回退成「显示 key 本身」，界面不报错，切语言才暴露；而组件把 `t` 绑到别人的命名空间时，
// 本包缺键也能显示正常文案（症状是「本包看着完整、拆出去就少一块」）。因此这里断言：
//   1. 三份区域字典合并后 en/zh 键集完全一致（缺键、多键都失败）；
//   2. 本包 web 源码里出现的静态文案键都在这份合并字典里（写了新键却忘了加字典 = 界面显示 key）；
//   3. 命名空间常量取自中心表（`TRACE_NS === NS.TRACE`），避免本包与宿主注册的命名空间字面量分歧。
//
// 直接读 JSON 而不是经 i18next 单例：宿主测试 mock 过 react-i18next（`t()` 回显 key），走单例会让断言依赖
// mock 状态；`locales/{en,zh}/*.json` 的路径形状本身就是包契约。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { NS } from "@fenix/web-runtime/i18n/namespace";
import { TRACE_NS } from "../i18n/namespace";

const WEB_ROOT = resolve(import.meta.dir, "..");
const LOCALES = join(WEB_ROOT, "i18n", "locales");

/** 每个语言目录下的全部区域字典文件（`trace-panel.json` / `trace-graph.json` / `trace-detail.json`）。 */
const DICT_FILES = ["trace-panel.json", "trace-graph.json", "trace-detail.json"] as const;

/** 读一个语言的全部字典并合并成一份（与 `web/i18n/index.ts` 的合并方式一致）。 */
function loadLanguage(language: "en" | "zh"): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const file of DICT_FILES) {
    Object.assign(merged, JSON.parse(readFileSync(join(LOCALES, language, file), "utf8")) as Record<string, unknown>);
  }
  return merged;
}

/** 把嵌套字典摊平成点号路径，便于逐键比对。 */
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

/** 递归收集 web 下的 .ts/.tsx 源码（排除测试与字典目录）。 */
function collectSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "__tests__" || entry === "i18n") continue;
      files.push(...collectSources(path));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) files.push(path);
  }
  return files;
}

/** 源码里所有 `t("a.b")` / `t('a.b')` 的字面量键（带插值的键在源码里也是字面量，插值在第二参数）。 */
function collectLiteralKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of collectSources(WEB_ROOT)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\bt\(\s*["']([a-zA-Z][\w.]*)["']/g)) keys.add(match[1]);
  }
  return keys;
}

describe("trace 字典", () => {
  // 业务意图：en/zh 键集必须逐键对应，缺一边就会在切语言时显示 key（且只有切语言才暴露）。
  test("en 与 zh 的键集完全一致", () => {
    const en = flatten(loadLanguage("en"));
    const zh = flatten(loadLanguage("zh"));
    expect([...en.keys()].sort()).toEqual([...zh.keys()].sort());
  });

  // 业务意图：三个区域字典的顶层键段互不重叠——重叠会在合并时静默覆盖整段文案（i18n/index.ts 用 Object.assign
  // 合并），这正是把字典拆成三份的前提。
  test("三份区域字典的顶层键段互不重叠", () => {
    for (const language of ["en", "zh"] as const) {
      const seen = new Set<string>();
      for (const file of DICT_FILES) {
        const dict = JSON.parse(readFileSync(join(LOCALES, language, file), "utf8")) as Record<string, unknown>;
        for (const key of Object.keys(dict)) {
          expect(seen.has(key), `${language}/${file} 的顶层键 ${key} 与前面的文件重叠`).toBe(false);
          seen.add(key);
        }
      }
    }
  });

  // 业务意图：源码里写了 `t("x.y")` 而字典里没有 = 界面直接显示 key；这类缺陷在类型系统里看不见。
  test("源码里的静态文案键都能在字典里查到", () => {
    const en = flatten(loadLanguage("en"));
    const missing = [...collectLiteralKeys()].filter((key) => !en.has(key));
    expect(missing).toEqual([]);
  });

  // 业务意图：命名空间常量必须取自中心表——本包写一份字面量、宿主按中心表注册，两份一旦分歧，整片文案
  // 回退成 key 且构建期无感。
  test("命名空间常量与中心表一致", () => {
    expect(TRACE_NS).toBe(NS.TRACE);
  });
});
