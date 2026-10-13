// web/__tests__/observer-i18n.test.ts
// 守护 observer 字典的完整性：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 都能查到、
// 已迁出命名空间的寄居键不再回流。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不会报错，
// 只有英文/中文来回切换才会暴露，容易漏到线上。这里直接读 JSON 文件（不经过 i18next 单例），
// 因此不受测试中 react-i18next 模块 mock 影响（宿主测试曾因 mock 让 t() 回显 key）。
//
// 路径注意：字典在 `web/i18n/locales/{en,zh}/observer.json`（与 sandbox / mcp 等包同形），由
// `web/i18n/index.ts` 转出给宿主注册；旧布局 `web/i18n/{en,zh}/` 已删除，宿主 `apps/web/src/i18n/index.ts`
// 的两行深层相对导入必须同步改指新路径（共享文件，见 README「边界残留」第 6 条）。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { OBSERVER_NS } from "../i18n/namespace";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/observer.json"), "utf8")) as Record<string, unknown>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/observer.json"), "utf8")) as Record<string, unknown>;

/** 把嵌套字典摊平成点号路径：`tree.leaves`、`states.loading`，顶层键保持原样。 */
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

/** 递归收集 web 下的 .ts/.tsx 源码（排除测试与字典目录自身）。 */
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

describe("observer 字典完整性", () => {
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

  // 命名空间归属：字典内容就是 observer 命名空间本身，键里不得再嵌一层 `observer.` 前缀
  // （宿主按 OBSERVER_NS 注册本文件，多一层前缀会让所有键变成 key 回显）。
  test("字典内不存在嵌套的 observer. 前缀键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("observer."));
    expect(nested).toEqual([]);
  });

  // 迁出键不得回流：`sandbox.*`（60 键，owner 是 sandbox 包）与 `modelGateway.*`（171 键，owner 是
  // model-management）已从 observer 命名空间删除，本包不再保留它们（§4：键的最终所在地 = 包的 owner）。
  test("字典内不存在 sandbox. / modelGateway. 寄居键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("sandbox.") || key.startsWith("modelGateway."));
    expect(nested).toEqual([]);
  });

  // 动态键（模板字面量拼接，字面量扫描覆盖不到）逐条钉住：漏一条就会在界面上回显 key。
  // `source.${row.source}` 的三个取值来自 OBSERVER_LINK_SOURCES，`stats.unit.${unit}` 的四个来自时长格式化。
  test("模板字面量动态键齐备（字面量扫描覆盖不到）", () => {
    for (const key of [
      "source.acp-ws",
      "source.external-relay",
      "source.chat-relay",
      "stats.unit.second",
      "stats.unit.minute",
      "stats.unit.hour",
      "stats.unit.day",
    ]) {
      expect(enFlat.has(key)).toBe(true);
      expect(zhFlat.has(key)).toBe(true);
    }
  });

  // 字典文件名必须等于命名空间常量：宿主按 `OBSERVER_NS` 注册本文件，两处不一致时整份字典都注册不上
  // （所有键回显 key）。同时钉住布局与旧路径已删除——旧路径 `web/i18n/{en,zh}/` 正是宿主深层相对
  // 导入的断链点，留着它会让「字典搬了、宿主还指向旧位置」的中间态静默通过包内测试。
  test("命名空间常量与字典文件名一致，旧布局已删除", () => {
    for (const locale of ["en", "zh"]) {
      expect(existsSync(join(WEB_ROOT, "i18n", "locales", locale, `${OBSERVER_NS}.json`))).toBe(true);
      expect(existsSync(join(WEB_ROOT, "i18n", locale, `${OBSERVER_NS}.json`))).toBe(false);
    }
    expect(existsSync(join(WEB_ROOT, "i18n", "en"))).toBe(false);
  });
});
