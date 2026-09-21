// web/__tests__/i18n-barrel.test.ts
// 守护本包自持的 `uiComponents` 字典与它的出口形态：en/zh 键集一致、插值占位符一致、
// 源码里写死的 t("key") 都能查到、常量与字典经同一个子路径出口暴露。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不报错，只有中英切换才暴露，
// 容易漏到线上。这里直接读 JSON 文件（不经过 i18next 单例），因此不受测试中 react-i18next 模块
// mock 影响（宿主测试曾因 mock 让 t() 回显 key）。
//
// 「本包自持」的边界（计划 §4「键的最终所在地 = 包的 owner」）：本包组件已全部收敛到
// `UI_COMPONENTS_NS`，不再借用宿主命名空间 `components`——原 `NS.COMPONENTS` 的字面量键随组件
// 迁入而加 `chat.components.` 前缀后落在本字典，因此这里没有 BORROWED_NAMESPACE_FILES 登记表。
//
// 出口形态（CE 阶段 2 §1.6 T3）：常量在 `web/i18n/namespace.ts`、字典在 `web/i18n/index.ts`，
// 宿主经 `@fenix/ui-components/i18n` 一次取到两者。旧深链 `./lib/i18n` 已删除。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const PKG_ROOT = resolve(WEB_ROOT, "..");
/**
 * 迁入基线：出口就位时的完整键数。只许增不许减——减少意味着删掉了组件仍在用的键。
 * 按增量维护：T9d 加 28 条 `chat.components.publicError.*`（公开错误正文的本地化文案），243 → 271。
 */
const KEY_BASELINE = 271;

const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/uiComponents.json"), "utf8")) as Record<
  string,
  unknown
>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/uiComponents.json"), "utf8")) as Record<
  string,
  unknown
>;

/** 把嵌套字典摊平成点号路径：`chat.components.commandMenu.title`、顶层键保持原样。 */
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

const enFlat = flatten(EN);
const zhFlat = flatten(ZH);

/** 源码里出现的字面量 `t("key")`，按 key 归组到使用它的文件。 */
function collectLiteralKeys(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const file of collectSources(WEB_ROOT)) {
    const relPath = relative(WEB_ROOT, file);
    for (const match of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([^"]+)"/g)) {
      usage.set(match[1], [...(usage.get(match[1]) ?? []), relPath]);
    }
  }
  return usage;
}

const literalKeys = collectLiteralKeys();

describe("ui-components uiComponents 字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致，且不低于出口就位基线", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(KEY_BASELINE);
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

  // 键集与占位符一致挡不住「zh 值照抄 en」这类漏译：键在、占位符也在，只是中文界面显示英文。
  // `quoteTruncatedBadge` 正是这样漏了很久（引用截断徽标在中文界面显示 "{{count}} chars omitted"），
  // T9b 修复后在此钉住；同类漏译应逐键在这里补一行断言，而不是放宽本条。
  test("已修复漏译：引用截断徽标的 zh 不是 en 的照抄", () => {
    const key = "chat.components.composerAssets.quoteTruncatedBadge";
    expect(zhFlat.get(key)).not.toBe(enFlat.get(key));
  });

  // 源码里所有字面量键都必须存在于字典（扫描有效性自检：覆盖到全部组件层）。
  test("源码中的字面量 t() 键都在字典内", () => {
    const missing = [...literalKeys.keys()].filter((key) => !enFlat.has(key) && !zhFlat.has(key));
    expect(missing).toEqual([]);
    expect(literalKeys.size).toBeGreaterThanOrEqual(190);
  });

  // 命名空间前缀不得写进键：字典处于 `uiComponents` 命名空间内，`uiComponents.xxx` 会翻译成
  // `uiComponents.uiComponents.xxx`。
  test("字典中不存在 uiComponents. 前缀的寄居键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("uiComponents."));
    expect(nested).toEqual([]);
  });

  // 命名空间字面量、字典文件名、以及宿主注册契约三处一致：宿主 `apps/web/src/i18n/index.ts`
  // 用中心表的 `NS.UI_COMPONENTS` 注册本模块，改名会让宿主侧查询落空。
  test("UI_COMPONENTS_NS 字面量为 uiComponents，且与字典文件名一致", () => {
    const namespaceSource = readFileSync(join(WEB_ROOT, "i18n/namespace.ts"), "utf8");
    expect(namespaceSource).toMatch(/UI_COMPONENTS_NS\s*=\s*"uiComponents"/);
    const indexSource = readFileSync(join(WEB_ROOT, "i18n/index.ts"), "utf8");
    expect(indexSource).toContain("./locales/en/uiComponents.json");
    expect(indexSource).toContain("./locales/zh/uiComponents.json");
  });

  // 出口 `./i18n` 必须同时给出常量与字典：宿主在启动时一次取用两者，缺任一个都会让宿主接线
  // 退回「复制字面量 + 深层相对导入 JSON」的旧形态。
  test("exports 的 ./i18n 指向字典出口，且旧深链 ./lib/i18n 已删除", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports: Record<string, { default?: string }>;
    };
    expect(pkg.exports["./i18n"]?.default).toBe("./web/i18n/index.ts");
    expect(pkg.exports["./lib/i18n"]).toBeUndefined();
    const indexSource = readFileSync(join(WEB_ROOT, "i18n/index.ts"), "utf8");
    expect(indexSource).toContain('export { UI_COMPONENTS_NS } from "./namespace"');
    expect(indexSource).toContain("export const uiComponentsResources");
  });

  // 包根 barrel 不得导出字典模块：宿主 i18n 在应用启动时求值，经根入口取字典会把整包组件图
  // 拉进首屏 bundle（observer 等 14 个包的 web/i18n/index.ts 注释记录同一条约束）。
  test("包根 barrel 只导出命名空间常量，不导出字典", () => {
    const barrel = readFileSync(join(WEB_ROOT, "index.ts"), "utf8");
    expect(barrel).toContain('export * from "./i18n/namespace"');
    expect(barrel).not.toContain("./i18n/index");
    expect(barrel).not.toContain("./lib/i18n");
  });

  // 组件只能经 `web/i18n/namespace` 取常量：常量与字典分文件声明，页面取常量不该拉入两份字典。
  test("组件侧不存在指向字典模块的导入", () => {
    const offenders = collectSources(WEB_ROOT).filter((file) => {
      if (file.startsWith(join(WEB_ROOT, "i18n"))) return false;
      return /from "[./]*i18n\/index"/.test(readFileSync(file, "utf8"));
    });
    expect(offenders.map((file) => relative(WEB_ROOT, file))).toEqual([]);
  });
});
