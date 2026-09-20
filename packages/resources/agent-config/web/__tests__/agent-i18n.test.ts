// web/__tests__/agent-i18n.test.ts
// 守护本包自持的 `agents` 字典：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 都能查到。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不报错，只有中英切换才暴露，
// 容易漏到线上。这里直接读 JSON 文件（不经过 i18next 单例），因此不受测试中 react-i18next 模块 mock
// 影响（宿主测试曾因 mock 让 t() 回显 key）。
//
// 「本包自持」的边界（计划 §4「键的最终所在地 = 包的 owner」）：本次迁入的只有 `agents` 命名空间
// （宿主 `apps/web/src/i18n/locales/*/agents.json` 的 271 个键）。站点相关组件仍借用宿主共享命名空间
// `components`（panelMode.* / siteFrame.* / confirmDialog.*）、`agentPanel`（siteDeployment.*）、
// `agentHome`——它们同时被 apps/web、chat-channel、model-management、agent-runtime 消费，
// 整体搬迁需要跨包裁定，不在本任务范围（见 BORROWED_NAMESPACE_FILES 与 README 的共享补丁清单）。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
/** 迁入基线：宿主 agents.json 的完整键数（271）。只许增不许减——减少意味着搬走了本包消费的键。 */
const MIGRATED_KEY_BASELINE = 271;

const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/agents.json"), "utf8")) as Record<string, unknown>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/agents.json"), "utf8")) as Record<string, unknown>;

/**
 * 仍借用宿主共享命名空间的组件：键的 owner 不在本包，因此它们的字面量键不参与本包字典断言。
 *
 * 每个条目都带「期望命名空间」，断言会校验该文件确实在用这个命名空间——借用是显式登记的状态，
 * 不是扫描漏网；组件改用 `agents` 命名空间（或这些键被裁定迁入）时这条断言会先变红，强制重新评审。
 */
const BORROWED_NAMESPACE_FILES: ReadonlyArray<{ file: string; namespace: string; reason: string }> = [
  {
    file: "components/agent-panel/SiteTabsBar.tsx",
    namespace: "NS.COMPONENTS",
    reason: "站点页签是跨包共享的宿主组件层文案（apps/web 与 model-management 同名组件共用）",
  },
  {
    file: "components/agent-panel/MountSiteDialog.tsx",
    namespace: "NS.COMPONENTS",
    reason: "挂载站点弹窗与宿主 artifacts-dialogs 共用 panelMode.* 键组",
  },
  {
    file: "components/agent-panel/SiteFrame.tsx",
    namespace: "NS.COMPONENTS",
    reason: "站点 iframe 外壳的 siteFrame.* 键组与宿主共享",
  },
  {
    file: "pages/agent-panel/components/AgentGenerationForm.tsx",
    namespace: "NS.AGENT_HOME",
    reason: "Agent 首页生成表单仍由 apps/web 的 AgentHomePage 消费同一批键",
  },
  {
    file: "pages/agent-panel/pages/AgentSitesPage.tsx",
    namespace: "NS.AGENT_PANEL",
    reason: "siteDeployment.* 键组由多个 agent-panel 页面共享，整体搬迁需跨包裁定",
  },
  {
    file: "pages/agent-panel/pages/agent-sites-catalog.tsx",
    namespace: "NS.AGENT_PANEL",
    reason: "同上",
  },
];

/** 把嵌套字典摊平成点号路径：`editor.sections.identity`、顶层键保持原样。 */
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

const enFlat = flatten(EN);
const zhFlat = flatten(ZH);
const borrowedFiles = new Map(BORROWED_NAMESPACE_FILES.map((entry) => [entry.file, entry]));

/** 源码里出现的字面量 `t("key")`，按文件归组（借用宿主命名空间的文件单独剔除）。 */
function collectLiteralKeys(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const file of collectSources(WEB_ROOT)) {
    const relPath = relative(WEB_ROOT, file);
    if (borrowedFiles.has(relPath)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(/\bt\(\s*"([^"]+)"/g)) {
      usage.set(match[1], [...(usage.get(match[1]) ?? []), relPath]);
    }
  }
  return usage;
}

const literalKeys = collectLiteralKeys();

describe("agent-config agents 字典完整性", () => {
  // 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("en / zh 键集完全一致，且不低于迁入基线", () => {
    expect([...zhFlat.keys()].sort()).toEqual([...enFlat.keys()].sort());
    expect(enFlat.size).toBeGreaterThanOrEqual(MIGRATED_KEY_BASELINE);
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

  // 源码里所有字面量键都必须存在于字典（扫描有效性自检：覆盖到全部编辑器与纯逻辑模块）。
  test("源码中的字面量 t() 键都在字典内", () => {
    const missing = [...literalKeys.keys()].filter((key) => !enFlat.has(key) && !zhFlat.has(key));
    expect(missing).toEqual([]);
    expect(literalKeys.size).toBeGreaterThanOrEqual(150);
  });

  // 借用宿主命名空间的登记表必须与源码一致：文件仍在使用声明的命名空间，键不会两头落空。
  test("登记借用宿主命名空间的文件确实在用该命名空间", () => {
    const drifted = BORROWED_NAMESPACE_FILES.filter(
      (entry) => !readFileSync(join(WEB_ROOT, entry.file), "utf8").includes(`useTranslation(${entry.namespace})`),
    );
    expect(drifted.map((entry) => `${entry.file} 未使用 ${entry.namespace}`)).toEqual([]);
  });

  // 借用键不得被复制进本包字典：同一批键两边各存一份会让 host 侧删除静默打断本包界面，
  // 也违反「键的最终所在地 = 包的 owner」。
  test("借用命名空间的键组没有复制进本包字典", () => {
    const borrowedGroups = ["siteDeployment", "panelMode", "siteFrame", "confirmDialog", "agentHome", "sidebar"];
    const duplicated = borrowedGroups.filter((group) => enFlat.has(`${group}.x`) || Object.hasOwn(EN, group));
    expect(duplicated).toEqual([]);
  });

  // 动态模板键无法被字面量扫描覆盖：section id 列表与可见性枚举必须逐个存在。
  // （`editor.sections` 的循环成员来自 AgentFormDialog 的 SECTIONS，取值 identity/model/capabilities/
  // knowledge/runtime/sharing；`editor.siteVisibility` 的成员来自资源可见性枚举。）
  test("动态模板键齐备（编辑器分区与站点可见性）", () => {
    for (const key of [
      "editor.sections.identity",
      "editor.sections.model",
      "editor.sections.capabilities",
      "editor.sections.knowledge",
      "editor.sections.runtime",
      "editor.sections.sharing",
      "editor.sectionCaptions.identity",
      "editor.sectionCaptions.model",
      "editor.sectionCaptions.capabilities",
      "editor.sectionCaptions.knowledge",
      "editor.sectionCaptions.runtime",
      "editor.sectionCaptions.sharing",
      "editor.siteVisibility.private",
      "editor.siteVisibility.org",
      "editor.siteVisibility.authenticated",
      "editor.siteVisibility.public",
    ]) {
      expect(enFlat.has(key)).toBe(true);
      expect(zhFlat.has(key)).toBe(true);
    }
  });

  // 命名空间前缀不得写进键：字典处于 `agents` 命名空间内，`agents.xxx` 会翻译成 `agents.agents.xxx`。
  test("字典中不存在 agents. 前缀的寄居键", () => {
    const nested = [...enFlat.keys()].filter((key) => key.startsWith("agents."));
    expect(nested).toEqual([]);
  });

  // 命名空间字面量与宿主注册契约一致：宿主 `apps/web/src/i18n/index.ts` 用 NS.AGENTS 注册本模块，
  // 新命名空间名（含改名）都会让宿主侧查询落空。字典文件名也必须与命名空间同名。
  test("AGENTS_NS 字面量为 agents，且字典文件名与命名空间一致", () => {
    const namespaceSource = readFileSync(join(WEB_ROOT, "i18n/namespace.ts"), "utf8");
    expect(namespaceSource).toMatch(/AGENTS_NS\s*=\s*"agents"/);
    const indexSource = readFileSync(join(WEB_ROOT, "i18n/index.ts"), "utf8");
    expect(indexSource).toContain("./locales/en/agents.json");
    expect(indexSource).toContain("./locales/zh/agents.json");
  });
});
