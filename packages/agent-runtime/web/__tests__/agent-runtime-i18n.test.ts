// 按消费文件实际绑定的 namespace 检查字典，防止其它页面的合法键污染 Chat 检查。
// 字典独立校验，不做 namespace union；动态键仅列当前两个真实消费场景。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  AGENT_CHAT_NS,
  AGENT_CONCURRENCY_NS,
  agentChatResources,
  agentConcurrencyResources,
} from "@fenix/agent-runtime/web/i18n";

const WEB_ROOT = resolve(import.meta.dir, "..");
const CONCURRENCY_PAGE = "pages/admin/AgentConcurrencyPage.tsx";

/** 把嵌套字典摊平成点号路径，供两种语言独立核对。 */
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

/** 递归收集本包源码，排除测试和字典自身。 */
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

/** 仅支持本包实际使用的两个 unaliased t 绑定；新绑定必须显式适配，不能静默忽略。 */
function namespaceOf(source: string): string {
  const bindings = [
    ...source.matchAll(/\{\s*t\s*\}\s*=\s*useTranslation\(\s*(AGENT_CHAT_NS|AGENT_CONCURRENCY_NS)\s*\)/g),
  ];
  const namespaces = new Set(bindings.map((binding) => binding[1]));
  if (namespaces.size !== 1) throw new Error("Expected one explicit namespace for unaliased t() calls");
  return namespaces.has("AGENT_CHAT_NS") ? AGENT_CHAT_NS : AGENT_CONCURRENCY_NS;
}

/** 按实际 namespace 收集字面量键，别名 tUi 的其它组件字典不属于本检查范围。 */
function literalUsage(source: string): { namespace: string; keys: string[] } | undefined {
  const keys = [...source.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1]);
  return keys.length ? { namespace: namespaceOf(source), keys } : undefined;
}

const sources = collectSources(WEB_ROOT).map((file) => ({
  file: relative(WEB_ROOT, file),
  source: readFileSync(file, "utf8"),
}));
const dictionaries = {
  [AGENT_CHAT_NS]: agentChatResources,
  [AGENT_CONCURRENCY_NS]: agentConcurrencyResources,
};

/** 逐 namespace 比对 en/zh，任何一个语言缺词都返回缺失键。 */
function missingLiteralKeys(source: string): string[] {
  const usage = literalUsage(source);
  if (!usage) return [];
  const resources = dictionaries[usage.namespace as keyof typeof dictionaries];
  const en = flatten(resources.en);
  const zh = flatten(resources.zh);
  return usage.keys.filter((key) => !en.has(key) || !zh.has(key));
}

/** 收集一个 namespace 的字面量消费点，同时保证全部 t 消费文件有可识别绑定。 */
function collectLiteralKeys(namespace: string): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const file of sources) {
    const calls = literalUsage(file.source);
    if (calls?.namespace !== namespace) continue;
    for (const key of calls.keys) usage.set(key, [...(usage.get(key) ?? []), file.file]);
  }
  return usage;
}

const concurrencyDynamicKeys = [
  "agentMaxConcurrency",
  "userAgentMaxConcurrency",
  "scheduledAgentMaxConcurrency",
  "sources.environment",
  "sources.global",
  "sources.user",
];

for (const [namespace, resources] of Object.entries(dictionaries)) {
  const en = flatten(
    JSON.parse(readFileSync(join(WEB_ROOT, `i18n/locales/en/${namespace}.json`), "utf8")) as Record<string, unknown>,
  );
  const zh = flatten(
    JSON.parse(readFileSync(join(WEB_ROOT, `i18n/locales/zh/${namespace}.json`), "utf8")) as Record<string, unknown>,
  );
  const literalKeys = collectLiteralKeys(namespace);
  const dynamicKeys = namespace === AGENT_CONCURRENCY_NS ? concurrencyDynamicKeys : [];

  describe(`agent-runtime ${namespace} 域字典完整性`, () => {
    // 两种语言的键必须对应，不能依赖另一语言兜底掩盖缺词。
    test("en / zh 键集完全一致", () => {
      expect([...zh.keys()].sort()).toEqual([...en.keys()].sort());
      expect(en.size).toBeGreaterThanOrEqual(12);
    });

    // 占位符按键逐条核对，避免翻译时遗失动态信息。
    test("en / zh 同一键的插值占位符一致", () => {
      const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
      expect(
        [...en.keys()].filter(
          (key) => JSON.stringify(placeholders(en.get(key) ?? "")) !== JSON.stringify(placeholders(zh.get(key) ?? "")),
        ),
      ).toEqual([]);
    });

    // 消费点只能在其实际绑定的 namespace 中找词，禁止跨字典补齐。
    test("源码中的字面量 t() 键都在对应字典内", () => {
      const missing = sources.flatMap((file) => {
        const usage = literalUsage(file.source);
        return usage?.namespace === namespace
          ? missingLiteralKeys(file.source).map((key) => `${file.file}:${key}`)
          : [];
      });
      expect(missing).toEqual([]);
      expect(literalKeys.size).toBeGreaterThanOrEqual(12);
    });

    // 反向保留 Chat 死词检查；并发页只豁免明确列出的六个动态消费键。
    test("字典中的每个键都有消费点", () => {
      expect([...en.keys()].filter((key) => !literalKeys.has(key) && !dynamicKeys.includes(key))).toEqual([]);
    });

    // 公开资源与磁盘字典逐项同源，宿主登记不能加载另一份键值。
    test("资源出口与命名空间常量同源", () => {
      expect(namespace).toBe(namespace === AGENT_CHAT_NS ? "agentChat" : "agentConcurrency");
      expect([...flatten(resources.en).entries()].sort()).toEqual([...en.entries()].sort());
      expect([...flatten(resources.zh).entries()].sort()).toEqual([...zh.entries()].sort());
    });
  });
}

describe("并发字典动态消费与 namespace 隔离", () => {
  // 维度及来源都是动态 t 调用，必须逐项验证两种语言具备对应键。
  test("三个并发维度及三种来源都有 en / zh 文案", () => {
    for (const locale of [agentConcurrencyResources.en, agentConcurrencyResources.zh]) {
      const flat = flatten(locale);
      for (const key of concurrencyDynamicKeys) expect(flat.has(key)).toBe(true);
    }
  });

  // 只存在并发字典的 global 必须在 Chat 消费中报缺失，不能由字典 union 蒙混过关。
  test("并发专有键不能让错误 Chat namespace 消费通过", () => {
    expect(flatten(agentConcurrencyResources.en).has("global")).toBe(true);
    expect(missingLiteralKeys('const { t } = useTranslation(AGENT_CHAT_NS); t("global");')).toEqual(["global"]);
    expect(missingLiteralKeys('const { t } = useTranslation(AGENT_CONCURRENCY_NS); t("global");')).toEqual([]);
  });

  // 真实页面应绑定并发 namespace，全部合法字面量键通过该字典独立校验。
  test("真实并发管理页只使用自己的字典", () => {
    const page = sources.find((file) => file.file === CONCURRENCY_PAGE);
    expect(page).toBeDefined();
    expect(namespaceOf(page?.source ?? "")).toBe(AGENT_CONCURRENCY_NS);
    expect(missingLiteralKeys(page?.source ?? "")).toEqual([]);
  });
});
