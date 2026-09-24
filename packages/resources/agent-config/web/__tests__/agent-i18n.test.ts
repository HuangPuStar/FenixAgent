// web/__tests__/agent-i18n.test.ts
// 守护本包自持的字典：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 都能查到。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不报错，只有中英切换才暴露，
// 容易漏到线上。这里直接读 JSON 文件（不经过 i18next 单例），因此不受测试中 react-i18next 模块 mock
// 影响（宿主测试曾因 mock 让 t() 回显 key）。
//
// 「本包自持」的边界（计划 §4「键的最终所在地 = 包的 owner」）：`agents`（宿主
// `apps/web/src/i18n/locales/<lang>/agents.json` 的 271 个键）、`dashboard`（概览页的 3 个键）与
// `agentHome`（「创建智能体」首页与它的生成表单，19 个键）——后两者随各自页面在 §1.6 T11e 归位。
// 站点相关组件仍借用宿主共享命名空间 `components`（panelMode.* / siteFrame.* / confirmDialog.*）与
// `agentPanel`（siteDeployment.*）：它们同时被 apps/web、chat-channel、model-management、
// agent-runtime 消费，整体搬迁需要跨包裁定，不在本任务范围（见 OTHER_NAMESPACE_FILES 与 README
// 的共享补丁清单）。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
/**
 * 迁入基线：宿主 agents.json 迁入本包时的完整键数（271）。只许增不许减——减少意味着搬走了本包消费的键。
 *
 * 下调到 228（2026-09-22 孤儿键清理）：本次删掉 46 个**全仓零引用**的键（`loadErrorShort` /
 * `columns.*` 5 个 / `actions.setDefault` / `batchDelete*` 4 个 / `dialog.tabs.*` 3 个 /
 * `templates.title` / `editor.*` 10 个 / `knowledge|skills|mcps|sites.*` 12 个 /
 * `resource.sharedSourceTitle` / `save.*` / `setDefault.*` / `delete.*` 5 个 / `categories.all`）。
 * 它们不是「本包消费的键」而是重构后失去引用的死键，因此这里下调常量并保留原判据
 * （仍为下界断言，继续拦住静默缩水）；`editor.sections.*`、`editor.sectionCaptions.*`、
 * `editor.siteVisibility.*` 等动态模板键族未被触碰。
 */
const MIGRATED_KEY_BASELINE = 228;

const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/agents.json"), "utf8")) as Record<string, unknown>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/agents.json"), "utf8")) as Record<string, unknown>;
const AGENT_HOME_EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/agentHome.json"), "utf8")) as Record<
  string,
  unknown
>;
const AGENT_HOME_ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/agentHome.json"), "utf8")) as Record<
  string,
  unknown
>;
const DASHBOARD_EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/dashboard.json"), "utf8")) as Record<
  string,
  unknown
>;
const DASHBOARD_ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/dashboard.json"), "utf8")) as Record<
  string,
  unknown
>;

/**
 * 绑定**非 `agents`** 命名空间的文件：它们的字面量键不参与 `agents` 字典断言。
 *
 * 两类都在此登记：① 键的 owner 仍在宿主（`components` / `agentPanel`，同时被别的包消费，
 * 整体搬迁需跨包裁定）；② 键的 owner 已在本包但属于另一个命名空间（`dashboard` / `agentHome`，
 * 其字典由下面独立的断言守护）。每个条目都带「期望命名空间」，断言会校验该文件确实在用这个命名空间——登记是显式
 * 状态而不是扫描漏网；文件改用 `agents` 命名空间（或那些键被裁定迁入）时这条断言会先变红，强制重新评审。
 */
const OTHER_NAMESPACE_FILES: ReadonlyArray<{ file: string; namespace: string; reason: string }> = [
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
    namespace: "AGENT_HOME_NS",
    reason: "键的 owner 已随首页迁入本包（见下方 agentHome 断言），表单与首页共用同一命名空间",
  },
  {
    file: "pages/agent-panel/pages/AgentHomePage.tsx",
    namespace: "AGENT_HOME_NS",
    reason: "同上；它还有 Trans 的 i18nKey 与动态 title1/2/3，无法被字面量扫描覆盖，另在下方断言里逐个点名",
  },
  {
    file: "pages/agent-panel/pages/AgentDashboardPage.tsx",
    namespace: "DASHBOARD_NS",
    reason: "概览页的字典与 `agents` 同属本包自持，只是另一个命名空间（见下方 dashboard 断言）",
  },
  {
    file: "pages/agent-panel/pages/AgentManagementPage.tsx",
    namespace: "NS.COMPONENTS",
    reason: "`statusBadge.all` 是筛选条与宿主 `components` 字典共用的键（唯一借用点），迁入会新增一份重复键",
  },
  {
    file: "pages/agent-panel/pages/AgentSitesPage.tsx",
    namespace: "NS.AGENT_PANEL",
    reason: "siteDeployment.* 键组由多个 agent-panel 页面共享，整体搬迁需跨包裁定",
  },
  {
    file: "pages/agent-panel/components/AgentSiteForm.tsx",
    namespace: "NS.AGENT_PANEL",
    reason: "同上：站点表单字段体是 AgentSitesPage 弹窗的字段部分，与页面同取 siteDeployment.* 键组",
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
const agentHomeEnFlat = flatten(AGENT_HOME_EN);
const agentHomeZhFlat = flatten(AGENT_HOME_ZH);
const dashboardEnFlat = flatten(DASHBOARD_EN);
const dashboardZhFlat = flatten(DASHBOARD_ZH);
const otherNamespaceFiles = new Map(OTHER_NAMESPACE_FILES.map((entry) => [entry.file, entry]));

/** 源码里出现的字面量 `t("key")`，按文件归组（绑定其他命名空间的文件单独剔除）。 */
function collectLiteralKeys(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const file of collectSources(WEB_ROOT)) {
    const relPath = relative(WEB_ROOT, file);
    if (otherNamespaceFiles.has(relPath)) continue;
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

  // 登记表必须与源码一致：文件仍在使用声明的命名空间，键不会两头落空。
  test("登记绑定其他命名空间的文件确实在用该命名空间", () => {
    const drifted = OTHER_NAMESPACE_FILES.filter(
      (entry) => !readFileSync(join(WEB_ROOT, entry.file), "utf8").includes(`useTranslation(${entry.namespace})`),
    );
    expect(drifted.map((entry) => `${entry.file} 未使用 ${entry.namespace}`)).toEqual([]);
  });

  // 其他命名空间的键组不得被复制进本包字典：同一批键两边各存一份会让 host 侧删除静默打断本包界面，
  // 也违反「键的最终所在地 = 包的 owner」。
  test("其他命名空间的键组没有复制进本包字典", () => {
    const foreignGroups = ["siteDeployment", "panelMode", "siteFrame", "confirmDialog", "sidebar", "dashboard"];
    const duplicated = foreignGroups.filter((group) => enFlat.has(`${group}.x`) || Object.hasOwn(EN, group));
    expect(duplicated).toEqual([]);
  });

  // `dashboard` 是本包自持的第二个命名空间（概览页随 §1.6 T11e 归位）：两份字典键集一致，
  // 且该页写死的字面量键都能查到——两半缺一，界面就会在某一语言下回显 key。
  test("dashboard 字典 en / zh 键集一致，且覆盖概览页的字面量键", () => {
    expect([...dashboardZhFlat.keys()].sort()).toEqual([...dashboardEnFlat.keys()].sort());
    const source = readFileSync(join(WEB_ROOT, "pages/agent-panel/pages/AgentDashboardPage.tsx"), "utf8");
    const used = [...source.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    const missing = used.filter((key) => !dashboardEnFlat.has(key) || !dashboardZhFlat.has(key));
    expect(missing).toEqual([]);
  });

  // `agentHome` 是本包自持的第三个命名空间（首页与其生成表单随 §1.6 T11e-3c 归位）：两份字典键集一致，
  // 两个消费方的字面量键都能查到，且三类字面量扫描覆盖不到的键——Trans 的 i18nKey、动态标题 id——
  // 逐个点名。少了任一半，界面就会在某一语言下回显 key（历史上该页曾在英文界面显示字面量键名）。
  test("agentHome 字典 en / zh 键集一致，且覆盖首页与生成表单的全部取键方式", () => {
    expect([...agentHomeZhFlat.keys()].sort()).toEqual([...agentHomeEnFlat.keys()].sort());
    const literalKeysOf = (relPath: string) =>
      [...readFileSync(join(WEB_ROOT, relPath), "utf8").matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1]);
    for (const file of [
      "pages/agent-panel/pages/AgentHomePage.tsx",
      "pages/agent-panel/components/AgentGenerationForm.tsx",
    ]) {
      const used = literalKeysOf(file);
      expect(used.length).toBeGreaterThan(0);
      expect(used.filter((key) => !agentHomeEnFlat.has(key) || !agentHomeZhFlat.has(key))).toEqual([]);
    }
    // 动态与组件式取键：标题三选一（`titleKey` 随机取）与 `Trans i18nKey="greeting"`。
    for (const key of ["title1", "title2", "title3", "greeting"]) {
      expect(agentHomeEnFlat.has(key)).toBe(true);
      expect(agentHomeZhFlat.has(key)).toBe(true);
    }
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

  // 命名空间字面量与宿主注册契约一致：宿主 `apps/web/src/i18n/index.ts` 用本模块的 `AGENTS_NS` /
  // `DASHBOARD_NS` / `AGENT_HOME_NS` 注册字典，新命名空间名（含改名）都会让宿主侧查询落空。
  // 字典文件名也必须与命名空间同名。
  test("三个命名空间字面量固定，且字典文件名与命名空间一致", () => {
    const namespaceSource = readFileSync(join(WEB_ROOT, "i18n/namespace.ts"), "utf8");
    expect(namespaceSource).toMatch(/AGENTS_NS\s*=\s*"agents"/);
    expect(namespaceSource).toMatch(/DASHBOARD_NS\s*=\s*"dashboard"/);
    expect(namespaceSource).toMatch(/AGENT_HOME_NS\s*=\s*"agentHome"/);
    const indexSource = readFileSync(join(WEB_ROOT, "i18n/index.ts"), "utf8");
    for (const locale of ["en", "zh"]) {
      for (const ns of ["agents", "dashboard", "agentHome"]) {
        expect(indexSource).toContain(`./locales/${locale}/${ns}.json`);
      }
    }
  });
});
