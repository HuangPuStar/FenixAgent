// web/__tests__/workflow-i18n.test.ts
// 守护 workflow 字典的完整性：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 都能查到。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不会报错，只有英中来回切换才暴露，
// 容易漏到线上。这里直接读 JSON 文件（不经过 i18next 单例），因此不受测试中 react-i18next 模块替身
// 的影响（宿主测试曾因 mock 让 t() 回显 key，把缺键问题盖住）。
//
// 字典路径与沙盒黄金样本一致：`web/i18n/locales/{en,zh}/workflows.json`（计划 §4 的包内统一形状），
// 由 `web/i18n/index.ts` 导出为 `workflowResources`，宿主从 `@fenix/resource-workflow/web/i18n` 取。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/workflows.json"), "utf8")) as Record<
  string,
  unknown
>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/workflows.json"), "utf8")) as Record<
  string,
  unknown
>;

/** 把嵌套字典摊平成点号路径：`list.title`、`nodes.status_running`，顶层键保持原样。 */
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

/** 源码里出现的全部字面量 `t("key")`（动态键如 t(`nodes.${nodeType}`) 由下面的家族断言覆盖）。 */
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

describe("workflow 字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(400);
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
    expect(literalKeys.size).toBeGreaterThanOrEqual(100);
  });

  // 键归属本包命名空间后不得再带 `workflows.` 前缀（i18next 已按命名空间寻址，双前缀会永远回显 key）。
  test("字典中不存在 workflows. 前缀的自带命名空间键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("workflows."));
    expect(nested).toEqual([]);
  });

  // 命名空间自持：本包只认自己的字典，`ns:key` 形式的跨命名空间键在包脱离宿主 i18n 装配后无人提供，
  // 实测只会把 key 原样渲染到界面上（宿主 components 命名空间里根本没有 `confirm` 这个键）。
  test("源码中的字面量键不跨命名空间", () => {
    const crossNamespace = [...literalKeys.entries()].filter(([key]) => key.includes(":"));
    expect(crossNamespace.map(([key, files]) => `${key} @ ${files.join(",")}`)).toEqual([]);
  });

  // 动态键（模板字符串拼接）无法被字面量扫描覆盖，按源码里的拼接家族单独断言。
  // `nodes.${nodeType}` 取值来自节点类型；`nodes.status_${status.toLowerCase()}` 取值来自运行状态。
  test("节点类型与运行状态动态键齐备", () => {
    for (const key of [
      "nodes.agent",
      "nodes.api",
      "nodes.audit",
      "nodes.custom",
      "nodes.end",
      "nodes.loop",
      "nodes.python",
      "nodes.shell",
      "nodes.start",
      "nodes.transform",
      "nodes.workflow",
      "nodes.status_pending",
      "nodes.status_running",
      "nodes.status_completed",
      "nodes.status_failed",
      "nodes.status_cancelled",
      "nodes.status_skipped",
    ]) {
      expect(enFlat.has(key)).toBe(true);
      expect(zhFlat.has(key)).toBe(true);
    }
  });

  // 顶层键组是宿主接线与页面消费面契约：新增组必须同步两份字典（缺一组会整片回显 key）。
  // `nav` 组的消费方是 web contribution 的导航项（`nav.workflow`，由 Shell 侧 `t(labelKey, { ns })`
  // 取值，见 web/contribution.ts 与 §1.6 T11b），不是页面源码里的字面量 `t()`，因此必须列在这里。
  test("顶层键组与页面消费面一致", () => {
    const groups = Object.keys(EN).sort();
    expect(groups).toEqual(["editor", "end_node", "list", "nav", "nodes", "page", "run_params", "runs", "versions"]);
    expect(Object.keys(ZH).sort()).toEqual(groups);
  });
});
