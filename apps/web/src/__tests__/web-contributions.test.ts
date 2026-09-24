// 浏览器 web contribution 的契约测试（§1.6 T11c）。
//
// 产物 `apps/generated/web-contributions.ts` 是「profile 选了哪些包」与「这些包申报了什么导航」的
// 汇合点：它在构建期由生成器校验（选择集、说明符、exports 出口），但生成器看不见**文案能不能取到**。
// 导航项只声明 `labelKey` + `ns`，Shell 用 `t(labelKey, { ns })` 取值；命名空间没登记、或键只存在于
// 一种语言时，界面会整片回退成 key 回显，而构建期与类型检查都不会报错。本文件把这条补齐。
//
// 字典取自各包 `web/i18n` 的导出（而不是磁盘 JSON 文件名）：命名空间字面量与字典文件的对应关系由各包
// 自己持有（`tasks-v2.json` ↔ `tasksV2` 就不按文件名），宿主 `i18n/index.ts` 登记的正是这些导出。
//
// 不初始化 i18next：单例一旦初始化会牵连语言探测与 localStorage，而本文件要断言的只是
// 「键在两种语言的字典里都在」——与 i18next 的取值行为无关。

import { expect, test } from "bun:test";
import { AGENTS_NS, agentResources } from "@fenix/agent-config/web/i18n";
import { APIKEY_NS, apikeyResources, ORGS_NS, orgResources } from "@fenix/identity/web/i18n";
import { MODELS_NS, modelManagementResources } from "@fenix/model-management/web/i18n";
import { KNOWLEDGE_NS, knowledgeResources } from "@fenix/resource-knowledge/web/i18n";
import { MCP_NS, mcpResources } from "@fenix/resource-mcp/web/i18n";
import { HINDSIGHT_NS, hindsightResources } from "@fenix/resource-memory/web/i18n";
import { PLUGIN_MARKET_NS, pluginMarketResources } from "@fenix/resource-plugin-market/web/i18n";
import { SKILL_NS, skillResources } from "@fenix/resource-skill/web/i18n";
import { TASKS_V2_NS, tasksV2Resources } from "@fenix/resource-task/web/i18n";
import { WORKFLOW_NS, workflowResources } from "@fenix/resource-workflow/web/i18n";
import { generatedWebContributions } from "../../../generated/web-contributions";

/** 命名空间 → 两种语言的字典；登记范围就是导航项可能声明的那几个包。 */
const DICTIONARIES = new Map<string, { readonly en: unknown; readonly zh: unknown }>([
  [AGENTS_NS, agentResources],
  [APIKEY_NS, apikeyResources],
  [ORGS_NS, orgResources],
  [MODELS_NS, modelManagementResources],
  [WORKFLOW_NS, workflowResources],
  [SKILL_NS, skillResources],
  [KNOWLEDGE_NS, knowledgeResources],
  [MCP_NS, mcpResources],
  [TASKS_V2_NS, tasksV2Resources],
  [HINDSIGHT_NS, hindsightResources],
  [PLUGIN_MARKET_NS, pluginMarketResources],
]);

/** 把嵌套字典摊平成点号路径，与各包 `*-i18n.test.ts` 的口径一致。 */
function flattenKeys(source: unknown, prefix = ""): Set<string> {
  const keys = new Set<string>();
  if (source === null || typeof source !== "object" || Array.isArray(source)) return keys;

  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const nested of flattenKeys(value, path)) keys.add(nested);
    } else {
      keys.add(path);
    }
  }
  return keys;
}

const contributions = generatedWebContributions.flatMap((contribution) =>
  (contribution.navigation ?? []).map((item) => ({ item, contribution })),
);

test("产物覆盖 profile 选定的全部贡献", () => {
  expect(generatedWebContributions.length).toBeGreaterThan(0);
  // 至少一个包贡献了导航，否则下面的断言会空转通过。
  expect(contributions.length).toBeGreaterThan(0);
});

test("导航项 id 全局唯一", () => {
  const ids = contributions.map(({ item }) => item.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("导航项声明的命名空间都有可解析的字典", () => {
  const namespaces = [...new Set(contributions.map(({ item }) => item.ns))].sort();
  for (const ns of namespaces) {
    expect(DICTIONARIES.has(ns)).toBe(true);
  }
});

test("导航项文案在声明的命名空间里（en / zh 都能取到）", () => {
  const missing: string[] = [];
  for (const { item } of contributions) {
    const dictionary = DICTIONARIES.get(item.ns);
    if (!dictionary) {
      missing.push(`${item.id}: 未登记的命名空间 ${item.ns}`);
      continue;
    }
    for (const lang of ["en", "zh"] as const) {
      if (!flattenKeys(dictionary[lang]).has(item.labelKey)) {
        missing.push(`${item.id}: ${item.ns}.${item.labelKey} 缺少 ${lang}`);
      }
    }
  }
  expect(missing).toEqual([]);
});
