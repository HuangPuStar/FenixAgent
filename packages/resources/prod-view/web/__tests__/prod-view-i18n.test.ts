// web/__tests__/prod-view-i18n.test.ts
// 守护 prodViews 字典的完整性：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 都能查到，
// 以及本波从宿主 `components` 命名空间迁入的 `panel.*` 键组一个不少。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不会报错，只有英文/中文来回切换
// 才会暴露，容易漏到线上。这里直接读 JSON 文件（不经过 i18next 单例），因此不受测试中
// react-i18next 模块 mock 影响。
//
// 目录布局是 `i18n/locales/{en,zh}/prodViews.json`（与黄金样本 sandbox 一致）：宿主
// `apps/web/src/i18n/index.ts` 的注册同批改走 `@fenix/resource-prod-view/web/i18n` 子路径
// （见 web/i18n/index.ts 的说明与 README「边界残留」的宿主 patch 清单）。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/prodViews.json"), "utf8")) as Record<
  string,
  unknown
>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/prodViews.json"), "utf8")) as Record<
  string,
  unknown
>;

/** 把嵌套字典摊平成点号路径：`panel.listTitle`、`modules.chatView`，顶层键保持原样。 */
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
      if (entry === "__tests__" || entry === "i18n") continue;
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

/** 源码里出现的全部字面量 `t("key")`（动态键如 t(`modules.${k}`) 由各自的字面量断言覆盖）。 */
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

/**
 * 本波从宿主 `apps/web/src/i18n/locales/{en,zh}/components.json` 的 `panelMode.views*` 迁入的键组：
 * 宿主键名 → 本包键名。逐个列出而不是只断言数量，因为「少迁一个键」在宿主侧删除后同样只会静默回显 key。
 */
const MIGRATED_PANEL_KEYS: ReadonlyMap<string, string> = new Map([
  ["viewsPanelModules", "moduleSection"],
  ["viewsLoadFailed", "loadFailed"],
  ["viewsUpdateSuccess", "updateSuccess"],
  ["viewsCreateSuccess", "createSuccess"],
  ["viewsDeleteSuccess", "deleteSuccess"],
  ["viewsToggleFailed", "toggleFailed"],
  ["viewsLinkCopied", "linkCopied"],
  ["viewsCopyFailed", "copyFailed"],
  ["viewsListTitle", "listTitle"],
  ["viewsEmptyHint", "emptyHint"],
  ["viewsEnabled", "enabled"],
  ["viewsDisabled", "disabled"],
  ["viewsOpenView", "openView"],
  ["viewsCopyLink", "copyLink"],
  ["viewsEdit", "edit"],
  ["viewsDelete", "delete"],
  ["viewsEditTitle", "editTitle"],
  ["viewsCreateTitle", "createTitle"],
  ["viewsLinkLabel", "linkLabel"],
  ["viewsNameLabel", "nameLabel"],
  ["viewsNamePlaceholder", "namePlaceholder"],
  ["viewsDescLabel", "descLabel"],
  ["viewsDescPlaceholder", "descPlaceholder"],
  ["viewsModulesLabel", "modulesLabel"],
  ["viewsCancel", "cancel"],
  ["viewsSave", "save"],
  ["viewsDeleteTitle", "deleteTitle"],
  ["viewsDeleteConfirm", "deleteConfirm"],
]);

describe("prod-view 字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(80);
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
    expect(literalKeys.size).toBeGreaterThanOrEqual(20);
  });

  // 面板文案改用本包命名空间（`panel.*`）后的直接回归点：28 个键一个不少。
  test("panel 键组齐备（宿主 panelMode.views* 的迁移结果）", () => {
    for (const target of MIGRATED_PANEL_KEYS.values()) {
      expect(enFlat.has(`panel.${target}`)).toBe(true);
      expect(zhFlat.has(`panel.${target}`)).toBe(true);
    }
    expect([...enFlat.keys()].filter((key) => key.startsWith("panel.")).length).toBe(MIGRATED_PANEL_KEYS.size);
  });

  // 迁出后宿主侧只删除；本包字典里不得再出现寄居期的 `panelMode.*` 键（回流即说明有页面还在读宿主的键）。
  test("字典中不存在 panelMode.* 寄居键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("panelMode."));
    expect(nested).toEqual([]);
  });

  // 模块名走动态键 `modules.${moduleKey}`，逐个钉住 12 个模块键都存在（字面量扫描覆盖不到）。
  test("模块名键齐备（动态键无法被字面量扫描覆盖）", () => {
    for (const key of [
      "chatHeader",
      "sessionSidebar",
      "chatView",
      "chatComposer",
      "permissionPanel",
      "todoPanel",
      "contextPanel",
      "toolCallRow",
      "filesPanel",
      "sitesPanel",
      "tasksPanel",
      "viewsPanel",
    ]) {
      expect(enFlat.has(`modules.${key}`)).toBe(true);
      expect(zhFlat.has(`modules.${key}`)).toBe(true);
    }
  });
});
