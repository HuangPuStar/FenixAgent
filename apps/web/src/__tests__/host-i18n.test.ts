// 宿主自有字典的契约测试。
//
// 为什么补这一份：每个资源包都有自己的 `<pkg>-i18n.test.ts` 守护字典，宿主此前一份都没有。缺口是真实
// 发生过的——`agentPanel.dragHint` 只在 en 有、zh 没有（中文界面回退成英文），以及 `TASKS`/`SESSIONS`/
// `ENVIRONMENTS`/`TOOL_NARRATOR` 四份字典迁出后留下空壳、连着 684 条无人消费的键长期无人发现，直到
// §1.6 T9c 用脚本清出。本文件把包侧已有的
// 那几条断言补到宿主侧，让同类漂移在提交时失败而不是等下一轮人工审计。
//
// 本文件只读磁盘上的 JSON 与源码文本，不初始化 i18next：宿主单例一旦被初始化会牵连语言探测与
// localStorage，且与本文件要断言的「字典文件与登记表是否一致」无关。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HOST = resolve(import.meta.dir, "..");
const LOCALES = join(HOST, "i18n/locales");
const BOOTSTRAP = join(HOST, "i18n/index.ts");
const LANGS = ["en", "zh"] as const;

/** 宿主字典文件名（不含扩展名）即命名空间字面量，宿主与包的命名空间在同一张中心表里登记。 */
const namespaces = readdirSync(join(LOCALES, "en"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))
  .sort();

/** 把嵌套字典摊平成点号路径，与包侧 `*-i18n.test.ts` 的口径一致。 */
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

function loadFlat(lng: string, ns: string): Map<string, string> {
  return flatten(JSON.parse(readFileSync(join(LOCALES, lng, `${ns}.json`), "utf8")) as Record<string, unknown>);
}

describe("宿主 i18n 字典契约", () => {
  // 单侧键是最隐蔽的一类缺陷：键在、界面不报错，只是缺的那一侧回退到 fallbackLng，用户看到另一门语言。
  // `agentPanel.dragHint` 正是这样从 en 单侧存在了很久。
  test("每份宿主字典的 en / zh 键集逐字一致", () => {
    const mismatched = namespaces
      .map((ns) => {
        const en = [...loadFlat("en", ns).keys()].sort();
        const zh = [...loadFlat("zh", ns).keys()].sort();
        return JSON.stringify(en) === JSON.stringify(zh) ? null : { ns, onlyEn: en.filter((k) => !zh.includes(k)) };
      })
      .filter(Boolean);
    expect(mismatched).toEqual([]);
  });

  // 反过来也要挡：两份字典里多出来的键没有任何消费方，正是 T9c 清掉的那 684 条死键的形态。
  // 两类语言都必须能找到同一个键，才能保证上面那条「键集一致」不是两边一起缺。
  test("每份宿主字典的两个语言文件都存在且非空", () => {
    for (const ns of namespaces) {
      for (const lng of LANGS) {
        expect(loadFlat(lng, ns).size, `${lng}/${ns}.json 为空`).toBeGreaterThan(0);
      }
    }
  });

  // 文件与登记表必须双向对上：磁盘上有字典却没登记 → 该命名空间永远回显 key（TASKS 等四份的形态）；
  // 登记了却没有文件 → 引导期 import 直接失败。两者的症状一个是静默回显、一个是构建期报错，都要挡。
  test("i18n 引导文件登记了全部且仅有磁盘上的宿主字典", () => {
    const bootstrap = readFileSync(BOOTSTRAP, "utf8");
    const unregistered = namespaces.filter(
      (ns) => !bootstrap.includes(`./locales/en/${ns}.json`) || !bootstrap.includes(`./locales/zh/${ns}.json`),
    );
    expect(unregistered).toEqual([]);
  });

  // 限定字面量 `t("common:cancel")` 是该命名空间对外可见的键，必须真实存在；这类引用跨包出现
  // （如 memory 包的 DocumentsView 引用宿主 `common`），删键时最容易连带踩掉。
  test('全仓限定字面量 t("<ns>:<key>") 都能在对应宿主字典里查到', () => {
    const dictionaries = new Map(namespaces.map((ns) => [ns, new Set(loadFlat("en", ns).keys())]));
    const missing: string[] = [];
    const collect = (dir: string, out: string[]) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (["node_modules", "dist", "locales", ".git"].includes(entry.name)) continue;
          collect(join(dir, entry.name), out);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          out.push(join(dir, entry.name));
        }
      }
    };
    const sources: string[] = [];
    // HOST 是 `apps/web/src`，上溯三级即仓库根。
    const repositoryRoot = resolve(HOST, "../../..");
    for (const root of ["apps/web", "packages"]) collect(resolve(repositoryRoot, root), sources);
    for (const file of sources) {
      for (const match of readFileSync(file, "utf8").matchAll(/"([a-zA-Z]+):([A-Za-z0-9_.]+)"/g)) {
        const [, ns, key] = match;
        if (dictionaries.has(ns) && !dictionaries.get(ns)?.has(key)) missing.push(`${ns}:${key} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });
});
