// web/__tests__/memory-i18n.test.ts
// 守护 hindsight 字典的完整性与其归属声明（键的最终所在地 = 本包）。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不报错、类型检查也不报错，
// 只有中英切换才会暴露，容易漏到线上。本文件直接读 JSON（不经过 i18next 单例），因此不受
// react-i18next 被 mock 的影响。
//
// 另一条被守护的契约是「字典位置不动」：宿主 `apps/web/src/i18n/index.ts` 已经改经本包的
// `@fenix/resource-memory/web/i18n` 出口（登记 `HINDSIGHT_NS` + `hindsightResources`）取字典，
// 该出口再指向这两份 JSON；「改经出口」不等于「路径可动」——包内挪动 JSON 位置同样会经出口断链。
// 断言用「文件真正在哪」的方式表达这份契约，而不是去读宿主源码——宿主接线再变（如 §1.6 页面重接线）
// 本文件不需要跟着改。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { NS } from "@fenix/web-runtime/i18n/namespace";
import { HINDSIGHT_NS, hindsightResources } from "../i18n";
import { HINDSIGHT_NS as HINDSIGHT_NS_DECLARED } from "../i18n/namespace";

const WEB_ROOT = resolve(import.meta.dir, "..");
const LOCALES_ROOT = join(WEB_ROOT, "i18n/locales");
const DICT_NAME = "hindsight";
const EN_PATH = join(LOCALES_ROOT, "en", `${DICT_NAME}.json`);
const ZH_PATH = join(LOCALES_ROOT, "zh", `${DICT_NAME}.json`);
const EN = JSON.parse(readFileSync(EN_PATH, "utf8")) as Record<string, unknown>;
const ZH = JSON.parse(readFileSync(ZH_PATH, "utf8")) as Record<string, unknown>;

/** 把嵌套字典摊平成点号路径：`tabs.worldFacts`、`title`；顶层标量键保持原样。 */
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

/** 递归收集 web 下的 .ts/.tsx 源码（排除测试目录与字典自身）。 */
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

const enFlat = flatten(EN);
const zhFlat = flatten(ZH);
const sources = collectSources(WEB_ROOT);

/** 源码里出现的全部字面量 `t("key")`（动态键如 t(item.labelKey) 无法静态扫描，另行断言）。 */
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
/** 本包命名空间内的字面量键（跨命名空间键以 `ns:key` 书写，尾段是 `:` 前的地方键）。 */
const ownLiteralKeys = new Map([...literalKeys].filter(([key]) => !key.includes(":")));

/**
 * 既有的缺键清单（本切片未修，属包内既有债务，见 README「已知项」）。
 *
 * 为什么固定成清单而不是直接断言为空：这 12 条缺键在本切片之前就存在（两份 JSON 本次零改动，
 * `git diff --stat -- web/i18n` 无输出可证），修复它们等于替产品补写 11 条中英文案，
 * 超出「边界切断」的范围。固定清单的价值是：**新增**缺键会立刻失败，而既有债务显式可见。
 */
const KNOWN_MISSING_KEYS = [
  // 点号误写：应为跨命名空间语法 `common:clear`，写成了 `common.clear`，
  // 在 hindsight 命名空间下查不到键，靠 `defaultValue: "Clear"` 兜底 → 中文界面固定显示英文。
  "common.clear",
  // Constellation 的节点 tooltip 行标签缺 4 条（同组其余行标签 tooltipContext/tooltipDocument 等齐备）。
  "constellation.tooltipEntities",
  "constellation.tooltipId",
  "constellation.tooltipProofs",
  "constellation.tooltipTags",
  // Graph2d 整组缺失：字典里没有 `graph2d` 分组，含 1 条带插值的链接类型标签。
  "graph2d.controlsHint",
  "graph2d.emptyState",
  "graph2d.linkTooltipEntity",
  "graph2d.linkTooltipWeight",
  "graph2d.linkTypeCausal",
  "graph2d.linkTypeGeneric",
  "graph2d.loading",
] as const;

/** 跨命名空间引用的字面量键：必须存在于**对方**命名空间，因此不出现在本字典里。 */
const CROSS_NAMESPACE_KEYS = ["common:cancel", "common:next", "common:previous"] as const;

describe("hindsight 字典完整性与归属", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  //
  // 基线 240 → 211（2026-09-22 孤儿键清理）：本次删掉 42 个全仓零引用的键
  // （`memories.*` / `documents.*` / `mentalModels.*` / `recall.*` / `retain.*` /
  // `memoryDetailPanel.*` / `constellation.*`），基线随之下调到清理后的实际键数（211），
  // 保持「只认当前真实规模、缩水即失败」的口径不变。
  test("en / zh 键集完全一致且规模未缩水", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(211);
  });

  // 插值占位符必须成对出现，否则某一语言会显示 `{{var}}` 字面量。
  test("en / zh 同一键的插值占位符一致", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    const mismatched = [...enFlat.keys()].filter(
      (key) =>
        JSON.stringify(placeholders(enFlat.get(key) ?? "")) !== JSON.stringify(placeholders(zhFlat.get(key) ?? "")),
    );
    expect(mismatched).toEqual([]);
  });

  // 源码里所有字面量键都必须命中字典，既有缺键固定成清单（新增缺键即失败）。
  test("源码字面量 t() 键除既有债务外全部命中字典", () => {
    const missing = [...ownLiteralKeys.keys()].filter((key) => !enFlat.has(key) && !zhFlat.has(key)).sort();
    expect(missing).toEqual([...KNOWN_MISSING_KEYS].sort());
    // 扫描有效性自检：字面量键（含跨命名空间）规模在百条量级，扫描失效会退化成空集。
    expect(literalKeys.size).toBeGreaterThanOrEqual(150);
  });

  // 跨命名空间引用是包对宿主的隐式依赖，只能依赖已登记的那三条，新增必须显式评审。
  test("跨命名空间字面量键固定为已登记的三条", () => {
    const namespaced = [...literalKeys.keys()].filter((key) => key.includes(":")).sort();
    expect(namespaced).toEqual([...CROSS_NAMESPACE_KEYS].sort());
  });

  // 字典即命名空间内容本身：若再嵌一层 `hindsight` 前缀，宿主注册后所有键都会错位一级。
  test("字典不存在 hindsight 前缀的嵌套键", () => {
    expect(EN[DICT_NAME]).toBeUndefined();
    expect([...enFlat.keys()].filter((key) => key.startsWith(`${DICT_NAME}.`))).toEqual([]);
  });

  // 命名空间字面量在三处出现（包内常量、web-runtime 注册表、字典文件名），任一处漂移都会整片回退成 key。
  test("命名空间字面量在包内常量、web-runtime 注册表与字典文件名之间一致", () => {
    expect(HINDSIGHT_NS_DECLARED).toBe(DICT_NAME);
    expect(HINDSIGHT_NS).toBe(HINDSIGHT_NS_DECLARED);
    expect(NS.HINDSIGHT).toBe(DICT_NAME);
  });

  // 出口转出的字典必须就是盘上那两份，否则宿主注册的内容与包内断言的内容会各说各话。
  test("web/i18n 出口转出的 en / zh 与盘上 JSON 逐字一致", () => {
    expect(flatten(hindsightResources.en as Record<string, unknown>)).toEqual(enFlat);
    expect(flatten(hindsightResources.zh as Record<string, unknown>)).toEqual(zhFlat);
  });

  // 字典必须留在 `web/i18n/locales/{en,zh}/hindsight.json`（出口相对 import 的路径契约，
  // 宿主已改经 `@fenix/resource-memory/web/i18n` 取值、不再直读盘上 JSON），
  // 同时 en/zh 两份必须同构存在——只留一份时 i18next 会 fallback 到另一种语言。
  test("字典路径固定为 i18n/locales/{en,zh}/hindsight.json", () => {
    expect(readFileSync(EN_PATH, "utf8").length).toBeGreaterThan(0);
    expect(readFileSync(ZH_PATH, "utf8").length).toBeGreaterThan(0);
    expect(readdirSync(join(LOCALES_ROOT, "en")).filter((file) => file.endsWith(".json"))).toEqual([
      `${DICT_NAME}.json`,
    ]);
    expect(readdirSync(join(LOCALES_ROOT, "zh")).filter((file) => file.endsWith(".json"))).toEqual([
      `${DICT_NAME}.json`,
    ]);
  });

  // 中文文案不得残留未翻译的英文（既有债务里的 graph2d 组只有 11 条键缺字典，另有 key 回显）。
  test("中文值不是未翻译的英文占位（抽样：与英文不同的比例下限）", () => {
    const differing = [...enFlat.keys()].filter((key) => enFlat.get(key) !== zhFlat.get(key)).length;
    expect(differing / enFlat.size).toBeGreaterThan(0.5);
  });
});
