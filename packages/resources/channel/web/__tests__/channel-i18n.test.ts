// web/__tests__/channel-i18n.test.ts
// 守护 channels 字典的完整性：en/zh 键集一致、插值占位符一致、web 面写死的 t("key") 都能查到。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不会报错，只有中英来回切换才暴露。
// 这里直接读 `i18n/locales/**` 的 JSON（不经过 i18next 单例），因此不受测试中 react-i18next 模块
// mock 影响；与同目录的 `channel-i18n-contract.test.ts` 分工——那个文件用 AST 钉住
// `AgentChannelsPage.tsx` 的单页契约（动态调用、JSX 裸字符串），本文件覆盖整个 `web/` 树的字典面。
//
// 路径与形状对照 `packages/resources/sandbox/web/__tests__/sandbox-i18n.test.ts`（任务 1.3 §4）。
//
// 用例数：5 条 = 与模板同形的 4 条（键集一致 / 插值占位符一致 / 字面量 `t()` 键齐备 / 无 `channels.`
// 嵌套键）+ 本包专属 1 条（`KEYS_WITHOUT_CONSUMER` 的无消费点键清单，模板里对应位置是「资源字段与单位键」
// 用例）——即 4→5，README「i18n 归属」一节记同一数字。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/channels.json"), "utf8")) as Record<string, unknown>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/channels.json"), "utf8")) as Record<string, unknown>;

/** 把嵌套字典摊平成点号路径：`dialog.title`、`table.emptyMessage`，顶层键保持原样。 */
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

/** web 源码里出现的全部字面量 `t("key")`（动态键如 t(field.labelKey) 由各自的字面量断言覆盖）。 */
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
 * 当前**没有**消费点的叶键（README「已知项」逐条列出的同一份清单）。
 *
 * 为什么要钉住：这份清单是 README 里唯一无法从代码直接看出的数字，历史上正是因为只按印象记账而漏记了
 * 5 个（bindingDeleted / unknownError / updateBindingFailed / dialog.agentPlaceholder /
 * dialog.chatIdPlaceholder），使「15 个无消费点」与实测的 20 个不符。钉成断言后，任何一侧变化都会失败。
 *
 * 维护方式：新增消费点或新增键时，先跑断言拿到差集，再同批更新本清单与 README「已知项」的计数
 * （复核命令见 README；`bindingDeleted` 已由 AgentChannelsPage 的删除成功提示消费，故不在此列）。
 */
const KEYS_WITHOUT_CONSUMER = [
  "columns.agent",
  "columns.all",
  "columns.chatId",
  "columns.enabled",
  "columns.platform",
  "dialog.agentPlaceholder",
  "dialog.cancel",
  "dialog.chatIdPlaceholder",
  "dialog.create",
  "dialog.creating",
  "hermes.address",
  "hermes.connected",
  "hermes.lastConnected",
  "hermes.notConfigured",
  "hermes.platforms",
  "hermes.reconnecting",
  "hermes.title",
  "updateBindingFailed",
];

describe("channels 字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(30);
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

  // web 面所有字面量键都必须存在于字典（扫描有效性自检：至少覆盖到页面文件里的全部调用）。
  test("源码中的字面量 t() 键都在字典内", () => {
    const missing = [...literalKeys.keys()].filter((key) => !enFlat.has(key) && !zhFlat.has(key));
    expect(missing).toEqual([]);
    expect(literalKeys.size).toBeGreaterThanOrEqual(15);
  });

  // 命名空间是 `channels`，字典自身必须保持平铺：`channels.*` 形状的嵌套键是宿主 ns 下的第二层，
  // 迁出/回流都会让键 owner 与字典 owner 分离（计划 §4）。
  test("字典中不存在 channels. 前缀的嵌套键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("channels."));
    expect(nested).toEqual([]);
  });

  // 无消费点的键清单必须与 README「已知项」逐字一致，避免两侧各记一份而漂移（历史缺陷见上方常量注释）。
  test("无消费点的键清单与 README 已知项一致", () => {
    const unused = [...enFlat.keys()].filter((key) => !literalKeys.has(key)).sort();
    expect(unused).toEqual(KEYS_WITHOUT_CONSUMER);
  });
});
