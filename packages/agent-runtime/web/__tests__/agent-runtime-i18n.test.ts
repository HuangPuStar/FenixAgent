// web/__tests__/agent-runtime-i18n.test.ts
// 守护 chat 域字典的完整性：en/zh 键集一致、插值占位符一致、源码里的字面量 `t("key")` 都能查到，
// 且字典里的每个键都有消费点（自持键集合只随本包实现变化，不留死键）。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不会报错，只有英文/中文来回切换才会
// 暴露，容易漏到线上。这里直接读 JSON 文件（不经过 i18next 单例），因此不受测试中 react-i18next
// 模块 mock 影响（宿主测试曾因 mock 让 t() 回显 key）。
//
// 本字典 2026-09-25 随台账 `ce-standards-todo.md` D1 新建：键从宿主 `agentPanel`（11 条）与
// `components`（`filePicker.title`）迁入，宿主侧同批删除，这里逐键反向守住「字典里的键都有消费点」，
// 防止搬迁留下另一半没有实现的键。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { AGENT_CHAT_NS, agentChatResources } from "../i18n/index";

const WEB_ROOT = resolve(import.meta.dir, "..");
const EN_PATH = join(WEB_ROOT, "i18n/locales/en/agentChat.json");
const ZH_PATH = join(WEB_ROOT, "i18n/locales/zh/agentChat.json");
const EN = JSON.parse(readFileSync(EN_PATH, "utf8")) as Record<string, unknown>;
const ZH = JSON.parse(readFileSync(ZH_PATH, "utf8")) as Record<string, unknown>;

/** 把嵌套字典摊平成点号路径：`filePicker.title`，顶层键保持原样。 */
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

/** 递归收集 web 下的 .ts/.tsx 源码（排除测试与字典自身——字典里的键不是消费点）。 */
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

/** 源码里出现的全部字面量 `t("key")`（动态键由各自的字面量断言覆盖）。 */
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

describe("agent-runtime chat 域字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(12);
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

  // 源码里所有字面量键都必须存在于字典（缺一条，对应分支就回显 key）。
  test("源码中的字面量 t() 键都在字典内", () => {
    const missing = [...literalKeys.keys()].filter((key) => !enFlat.has(key) && !zhFlat.has(key));
    expect(missing).toEqual([]);
    expect(literalKeys.size).toBeGreaterThanOrEqual(12);
  });

  // 反方向：字典里的每个键都要有字面量消费点——搬迁只带走键、不带走消费方时，这条会失败。
  test("字典中的每个键都有消费点", () => {
    const orphans = [...enFlat.keys()].filter((key) => !literalKeys.has(key));
    expect(orphans).toEqual([]);
  });

  // 资源出口与常量同源：宿主登记的 NS 与字典必须来自同一份数据，否则整片回退成 key。
  test("资源出口与命名空间常量同源", () => {
    expect(AGENT_CHAT_NS).toBe("agentChat");
    // 经同一个 flatten 口径比较：index.ts 导出的资源与磁盘上两份 JSON 的键值逐条一致。
    expect([...flatten(agentChatResources.en).entries()].sort()).toEqual([...enFlat.entries()].sort());
    expect([...flatten(agentChatResources.zh).entries()].sort()).toEqual([...zhFlat.entries()].sort());
  });
});
