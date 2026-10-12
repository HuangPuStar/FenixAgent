// web/__tests__/tickets-i18n.test.ts
// 守护 tickets 字典的**自持性**与完整性（计划 §4：键的最终所在地 = 包的 owner）。
//
// 自持性为什么必须静态断言：i18next 缺键时只回退成「显示 key 本身」，界面不报错，只有切换语言才暴露。
// 而当组件把 `t` 绑到**别人的命名空间**（宿主 `components`、兄弟包）时，本包字典缺键也能显示正常文案——
// 症状是「本包看起来完整、拆出去就少一块」。所以这里断言三件事：
//   1. 字典自身完整（en/zh 键集一致、插值占位符一致、源码字面量键与 schema 校验键都查得到）；
//   2. 本包 web 源码的文案只经 `tickets` 取（绑定常量只有 `NS.TICKETS`，见 `web/i18n/namespace.ts`）；
//   3. contribution 声明的导航 `labelKey`（`nav.tickets`）也在本包字典里——Shell 是按贡献里声明的
//      `ns` 去取这一条的，宿主不持有同名键，漏了它侧栏就回显键名。
//
// 直接读 JSON 文件而不是经 i18next 单例：宿主测试 mock 过 react-i18next（`t()` 回显 key），
// 走单例会让断言依赖 mock 状态；JSON 路径本身是包契约（计划 §4 的 `web/i18n/locales/{en,zh}/` 形状，
// 宿主只许经 `@fenix/resource-tickets/web/i18n` 取），因此顺带钉住路径。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { NS } from "@fenix/web-runtime/i18n/namespace";

const WEB_ROOT = resolve(import.meta.dir, "..");
const DICT_DIR = join(WEB_ROOT, "i18n");
const EN = JSON.parse(readFileSync(join(DICT_DIR, "locales/en/tickets.json"), "utf8")) as Record<string, unknown>;
const ZH = JSON.parse(readFileSync(join(DICT_DIR, "locales/zh/tickets.json"), "utf8")) as Record<string, unknown>;

/** 把嵌套字典摊平成点号路径：`loadState.failed`、`nav.tickets`，顶层键保持原样。 */
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
 * 源码里的字面量取键调用 `t("key")`：只收「小写开头、点号分段」的键形态。同一条正则还会命中
 * `DateTimeFormat("en-US")`、`.default("POST")` 这类非 i18n 调用，它们都带大写或连字符，
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

/**
 * 字面量键数量的下限（扫描有效性自检）。2026-10-12 实测本包 web 面共 53 个：
 * 少于这个数说明正则失配或源码被整文件跳过，而不是「文案变少了」。
 */
const LITERAL_KEY_FLOOR = 53;

describe("tickets 字典完整性与自持性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    // 58 是当前真实键数（2026-10-12，删掉无消费方的 sync.syncing 后）；低于它说明 flatten 没走到 nested 层，后续断言会假绿。
    expect(enFlat.size).toBeGreaterThanOrEqual(58);
  });

  // 插值占位符必须成对出现，否则某一语言会显示 {{var}} 字面量（本包有 loadedCount / syncedAtLabel 两处）。
  test("en / zh 同一键的插值占位符一致", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    const mismatched = [...enFlat.keys()].filter(
      (key) =>
        JSON.stringify(placeholders(enFlat.get(key) ?? "")) !== JSON.stringify(placeholders(zhFlat.get(key) ?? "")),
    );
    expect(mismatched).toEqual([]);
    // 占位符扫描的有效性自检：至少命中一条带插值的键（否则上面那条恒真）。
    expect([...enFlat.values()].some((value) => placeholders(value).length > 0)).toBe(true);
  });

  // 源码里所有字面量键都必须存在于字典（扫描有效性自检：至少覆盖到全部页面文件）。
  test("源码中的字面量 t() 键都在字典内", () => {
    const missing = [...literalKeys.keys()].filter((key) => !enFlat.has(key) && !zhFlat.has(key));
    expect(missing).toEqual([]);
    expect(literalKeys.size).toBeGreaterThanOrEqual(LITERAL_KEY_FLOOR);
  });

  // `ticketFormSchema` 的 message 是「裸字符串」形态（zod 不认键类型），字面量 t() 扫描扫不到它：
  // 这里单独把 schema 源码里的 `validation.*` 字面量对齐到字典，否则写错的键会原样显示在表单错误行上。
  // `bodyRequired` 是本批补上的那条（后端 `body` 必填 `min(1)`，此前靠原生 required 兜底）——
  // 它同时被「正文为空 → 校验拦截」的组件用例覆盖，这条静态断言保证的是键真的在字典里。
  test("创建表单的 zod 校验键都在字典内", () => {
    const source = readFileSync(join(WEB_ROOT, "pages/agent-panel/components/ticket-create-dialog.tsx"), "utf8");
    const keys = [...source.matchAll(/"validation\.[A-Za-z]+"/g)].map((match) => match[0].slice(1, -1));
    // 扫描有效性自检：标题必填/上限 + 正文必填/上限四条键缺一不可，正则失配时不能假绿。
    for (const key of [
      "validation.titleRequired",
      "validation.titleMax",
      "validation.bodyRequired",
      "validation.bodyMax",
    ]) {
      expect(keys).toContain(key);
    }
    const missing = keys.filter((key) => !enFlat.has(key) || !zhFlat.has(key));
    expect(missing).toEqual([]);
  });

  // 与本包命名空间互为因果：组件与 hooks 的文案绑定只能交给本包的 TICKETS_NS 常量。
  // 直接写宿主命名空间字面量（`useTranslation("components")`）会让本包字典缺键也照样显示文案，
  // 因此这里断言「源码里出现的命名空间实参只有 TICKETS_NS、且没有裸字符串绑定」。
  test("本包 web 源码的文案绑定只经 TICKETS_NS 常量，不绑宿主命名空间", () => {
    const bindings = new Set<string>();
    const literalBindings: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/useTranslation\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g)) bindings.add(match[1]);
      for (const match of source.matchAll(/useTranslation\(\s*"([^"]+)"/g)) {
        literalBindings.push(`${relative(WEB_ROOT, file)} → useTranslation("${match[1]}")`);
      }
    }
    expect([...bindings]).toEqual(["TICKETS_NS"]);
    expect(literalBindings).toEqual([]);
  });

  // 命名空间常量与共享 NS 表同源（两份字面量分歧时，症状是文案整片回退成 key 且构建期不可见）。
  test("命名空间常量取自共享 NS 表的 tickets", () => {
    expect(NS.TICKETS).toBe("tickets");
  });

  // 侧栏文案由 Shell 按贡献里声明的 ns + labelKey 取：这条键必须在**本包**字典里，宿主不持有同名键。
  test("contribution 声明的导航文案 nav.tickets 自持于本包字典", () => {
    const contribution = readFileSync(join(WEB_ROOT, "contribution.ts"), "utf8");
    expect(contribution).toContain('labelKey: "nav.tickets"');
    expect(contribution).toContain("ns: TICKETS_NS");
    expect(enFlat.get("nav.tickets")).toBe("Tickets");
    expect(zhFlat.get("nav.tickets")).toBe("工单");
  });

  // 字典落点由计划 §4 固定为 `web/i18n/locales/{en,zh}/`：宿主只经 `./web/i18n` 子路径取字典，
  // 而那个出口正是相对 import 这两份 JSON；出现第二份落点（或旧形状的副本）会让两侧各拿一份、静默分叉。
  test("字典落在 locales/ 形状且由 web/i18n 出口转出", () => {
    const index = readFileSync(join(DICT_DIR, "index.ts"), "utf8");
    expect(index).toContain('from "./locales/en/tickets.json"');
    expect(index).toContain('from "./locales/zh/tickets.json"');
    expect(index).toContain("ticketsResources");
    expect(index).toContain("TICKETS_NS");
    for (const duplicate of ["en/tickets.json", "zh/tickets.json"]) {
      expect(existsSync(join(DICT_DIR, duplicate))).toBe(false);
    }
  });
});
