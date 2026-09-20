// web/__tests__/task-i18n.test.ts
// 守护 task 字典的**自持性**与完整性（计划 §4：键的最终所在地 = 包的 owner）。
//
// 自持性为什么必须静态断言：i18next 缺键时只回退成「显示 key 本身」，界面不报错，只有切换语言才暴露。
// 而当组件把 `t` 绑到**别人的命名空间**（宿主 `components`、兄弟包）时，本包字典缺键也能显示正常文案——
// 症状是「本包看起来完整、拆出去就少一块」。所以这里断言两件事：
//   1. 字典自身完整（en/zh 键集一致、插值占位符一致、源码字面量键与动态键都查得到）；
//   2. 本包 web 源码的文案只经 `tasksV2` 取（绑定常量只有 `NS.TASKS_V2`），面板文案 `panelMode.tasks*`
//      在包内字典里（2026-09-20 从宿主 `components` 命名空间迁入，宿主同名键由 W3 的宿主 patch 删除，
//      清单见 README「边界外的已知项」）。
//
// 直接读 JSON 文件而不是经 i18next 单例：宿主测试 mock 过 react-i18next（`t()` 回显 key），
// 走单例会让断言依赖 mock 状态；JSON 路径本身是包契约（计划 §4 的 `web/i18n/locales/{en,zh}/` 形状，
// 宿主只许经 `@fenix/resource-task/web/i18n` 取），因此顺带钉住路径。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { NS } from "@fenix/web-runtime/i18n/namespace";

const WEB_ROOT = resolve(import.meta.dir, "..");
const DICT_DIR = join(WEB_ROOT, "i18n");
const EN = JSON.parse(readFileSync(join(DICT_DIR, "locales/en/tasks-v2.json"), "utf8")) as Record<string, unknown>;
const ZH = JSON.parse(readFileSync(join(DICT_DIR, "locales/zh/tasks-v2.json"), "utf8")) as Record<string, unknown>;

/** 把嵌套字典摊平成点号路径：`panelMode.tasksEmpty`、`status.success`，顶层键保持原样。 */
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

/** 递归收集 web 下的 .ts/.tsx 源码（排除测试、字典与图守卫工具）。 */
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

/**
 * 源码里的字面量取键调用 `t("key")` / `taskT("key")`（同一个组件里两种绑定别名并存）：
 * 只收「小写开头、点号分段」的键形态。同一条正则还会命中 `DateTimeFormat("en-US")`、
 * `.default("POST")`、`.split("-")` 这类非 i18n 调用，它们都带大写或连字符，
 * 被形态过滤挡掉——否则断言会因为与文案无关的调用而假红。
 */
function collectLiteralKeys(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  const call = /\b[tT][A-Za-z0-9_]*\(\s*"([a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)"/g;
  for (const file of sources) {
    const relPath = relative(WEB_ROOT, file);
    for (const match of readFileSync(file, "utf8").matchAll(call)) {
      usage.set(match[1], [...(usage.get(match[1]) ?? []), relPath]);
    }
  }
  return usage;
}

const literalKeys = collectLiteralKeys();

/** 迁入本包的面板文案键：宿主 `components.panelMode.tasks*` 的同名键由 W3 的宿主 patch 删除。 */
const MIGRATED_PANEL_KEYS = [
  "panelMode.tasksEmpty",
  "panelMode.tasksListTitle",
  "panelMode.tasksLoadFailed",
  "panelMode.tasksManage",
  "panelMode.tasksToggleFailed",
  "panelMode.tasksTriggerFailed",
];

describe("task 字典完整性与自持性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(100);
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

  // 模板键（`status.${...}`）无法被字面量扫描覆盖：整组必须在字典里，否则页面会出现回显 key。
  test("动态模板键的键组齐备（status / type / cron.presets）", () => {
    for (const prefix of ["status.", "type.", "cron.presets."]) {
      const enKeys = [...enFlat.keys()].filter((key) => key.startsWith(prefix));
      const zhKeys = [...zhFlat.keys()].filter((key) => key.startsWith(prefix));
      expect(enKeys.length).toBeGreaterThan(0);
      expect(zhKeys).toEqual(enKeys);
    }
    // 运行状态是模板键里唯一的「枚举值来自后端」的一组：取值集合写死在这里，避免后端加状态后静默回显。
    for (const status of ["success", "failed", "timeout", "skipped", "pending"]) {
      expect(enFlat.has(`status.${status}`)).toBe(true);
      expect(zhFlat.has(`status.${status}`)).toBe(true);
    }
  });

  // 面板文案曾借宿主 components 命名空间（同键在宿主字典里），迁入后必须两边都取到本包的键。
  test("panelMode.tasks* 面板文案自持于本包字典", () => {
    for (const key of MIGRATED_PANEL_KEYS) {
      expect(enFlat.has(key)).toBe(true);
      expect(zhFlat.has(key)).toBe(true);
      expect(literalKeys.get(key)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  // 与上一条互为因果：本包组件的文案绑定常量只能是 tasksV2，绑到别的命名空间就等于把键的归属交出去。
  test("本包 web 源码的文案绑定只使用 tasksV2 命名空间", () => {
    const constants = new Set<string>();
    for (const file of sources) {
      for (const match of readFileSync(file, "utf8").matchAll(/NS\.([A-Z_0-9]+)/g)) {
        constants.add(match[1]);
      }
    }
    expect([...constants]).toEqual(["TASKS_V2"]);
  });

  // 命名空间常量与共享 NS 表同源（两份字面量分歧时，症状是文案整片回退成 key 且构建期不可见）。
  test("命名空间常量取自共享 NS 表的 tasksV2", () => {
    expect(NS.TASKS_V2).toBe("tasksV2");
  });

  // 字典落点由计划 §4 固定为 `web/i18n/locales/{en,zh}/`：出口相对 import 这两份文件，旧路径不得回流
  // （回流会让宿主已落地的 `./web/i18n` 切换与旧路径 import 分叉成两套落点）。
  test("字典落在 locales/ 形状且由资源出口转出", () => {
    const index = readFileSync(join(DICT_DIR, "index.ts"), "utf8");
    expect(index).toContain('from "./locales/en/tasks-v2.json"');
    expect(index).toContain('from "./locales/zh/tasks-v2.json"');
    expect(index).toContain("tasksV2Resources");
    expect(index).toContain("TASKS_V2_NS");
    for (const legacy of ["en/tasks-v2.json", "zh/tasks-v2.json"]) {
      expect(existsSync(join(DICT_DIR, legacy))).toBe(false);
    }
  });
});
