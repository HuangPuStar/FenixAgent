// web/__tests__/plugin-market-i18n.test.ts
// 守护插件市场字典的完整性：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 都能查到、
// 动态拼接的键族齐备，以及「键与 JSON 路径都留在本包」这一归属约束。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不会报错，只有中英来回切换才暴露。
// 这里直接读 JSON（不经过 i18next 单例），因此不受测试中 react-i18next mock 影响。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/pluginMarket.json"), "utf8")) as Record<
  string,
  unknown
>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/pluginMarket.json"), "utf8")) as Record<
  string,
  unknown
>;
/** 字典落点：宿主 `apps/web/src/i18n/index.ts` 经 `@fenix/resource-plugin-market/web/i18n` 消费它们。 */
const JSON_PATHS = ["i18n/locales/en/pluginMarket.json", "i18n/locales/zh/pluginMarket.json"] as const;

/** 把嵌套字典摊平成点号路径：`detail.overview`、`toast.published`，顶层键保持原样。 */
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

/** 源码里出现的全部字面量 `t("key")`（动态键由下面的键族断言覆盖）。 */
function collectLiteralKeys(sources: readonly string[]): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const file of sources) {
    const relPath = relative(WEB_ROOT, file);
    for (const match of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([^"]+)"/g)) {
      usage.set(match[1], [...(usage.get(match[1]) ?? []), relPath]);
    }
  }
  return usage;
}

const sources = collectSources(WEB_ROOT);
const enFlat = flatten(EN);
const zhFlat = flatten(ZH);
const literalKeys = collectLiteralKeys(sources);

describe("插件市场字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(70);
  });

  // 插值占位符必须成对出现，否则某一语言会显示 {{var}} 字面量（本包所有写入结果提示都带版本号插值）。
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
    expect(literalKeys.size).toBeGreaterThanOrEqual(50);
  });

  // 动态键族无法被字面量扫描覆盖，逐个点名（这几条一并补上「两份字典都必须有」——上面那条字面量扫描
  // 只要求两份里至少一份命中，字段错误行的两键就在这个差集里）：
  // - 发布表单的两个字段级校验 key（§4.3 起由字段体按字段取用，不再经 `validatePublishTarget` 返回）；
  // - `changeToastKey` 返回的四条写入结果提示（noop 必须与 publish 分开，它不能说「已发布」）；
  // - 四个目录筛选口径（`ScopeFilterBar` 的选项由页面拼装，键本身是字面量，这里再钉一次顺序无关的完整性）。
  test("动态键族齐备（发布校验、写入结果提示、筛选口径）", () => {
    for (const key of [
      "validation.packageNameRequired",
      "validation.exactVersionRequired",
      "toast.published",
      "toast.noop",
      "toast.unpublished",
      "toast.restored",
      "scope.all",
      "scope.teams",
      "scope.connectors",
      "scope.withdrawn",
      // 侧栏项文案：由 `web/contribution.ts` 声明 labelKey，缺键会让侧栏显示 `nav.pluginMarket`。
      "nav.pluginMarket",
    ]) {
      expect(enFlat.has(key), `en 缺 ${key}`).toBe(true);
      expect(zhFlat.has(key), `zh 缺 ${key}`).toBe(true);
    }
  });

  // 键的最终所在地 = 包的 owner：不得出现带本包命名空间前缀的寄居键（迁移遗留的 `pluginMarket.` 前缀）。
  test("字典中不存在带命名空间前缀的寄居键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("pluginMarket."));
    expect(nested).toEqual([]);
  });

  // JSON 路径是宿主消费这批文案的合同；`web/i18n/index.ts` 必须指向同一批文件，且不得反向依赖 src。
  test("字典路径未变，且 web/i18n 出口指向同一批 JSON", () => {
    const entrySource = readFileSync(join(WEB_ROOT, "i18n/index.ts"), "utf8");
    for (const path of JSON_PATHS) {
      expect(statSync(join(WEB_ROOT, path)).isFile()).toBe(true);
      expect(entrySource).toContain(`./locales/${path.split("/").slice(2).join("/")}`);
    }
    expect(entrySource).not.toContain("../src/");
  });

  // 命名空间常量由本包声明（键归属本包），宿主登记处引用同一常量。
  test("命名空间常量是包自有的字面量", () => {
    const namespaceSource = readFileSync(join(WEB_ROOT, "i18n/namespace.ts"), "utf8");
    expect(namespaceSource).toContain('export const PLUGIN_MARKET_NS = "pluginMarket"');
    const entrySource = readFileSync(join(WEB_ROOT, "i18n/index.ts"), "utf8");
    expect(entrySource).toContain("pluginMarketResources");
  });
});
