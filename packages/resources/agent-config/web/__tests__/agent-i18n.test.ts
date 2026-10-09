// web/__tests__/agent-i18n.test.ts
// 守护本包自持的字典：en/zh 键集一致、插值占位符一致、源码里写死的 t("key") 以及经端口/别名
// （`tp` / `tUi` / `tc` / `translate`）消费的字面量键都能查到。
//
// 为什么必须静态断言：i18next 缺键时回退为「显示 key 本身」，界面不报错，只有中英切换才暴露，
// 容易漏到线上。这里直接读 JSON 文件（不经过 i18next 单例），因此不受测试中 react-i18next 模块 mock
// 影响（宿主测试曾因 mock 让 t() 回显 key）。
//
// 「本包自持」的边界（计划 §4「键的最终所在地 = 包的 owner」）：`agents`（宿主
// `apps/web/src/i18n/locales/<lang>/agents.json` 的 271 个键）、`dashboard`（概览页的 3 个键）与
// `agentHome`（「创建智能体」首页与它的生成表单，19 个键）——后两者随各自页面在 §1.6 T11e 归位。
// 2026-09-24 台账 D4（两份宿主字典的键归属拆分余量）后，站点相关组件不再借用宿主命名空间：
// 宿主 `components` 的 `panelMode.*`（站点部分）/ `siteFrame.*` 与宿主 `agentPanel` 的
// `siteDeployment.*`、编辑器重启词条按「键的最终所在地 = 消费方所在包」原样迁入本包 `agents` 字典，
// 宿主侧只删除、不保留副本（宿主装配点改绑 `NS.AGENTS`）。上一版这里记的原因是「同时被 apps/web、
// chat-channel、model-management、agent-runtime 消费，整体搬迁需跨包裁定」——实测该消费方清单不成立：
// 站点键的消费方只有本包与 apps/web 的 artifacts 外壳，故本批完成裁定并落库。
// 仍绑第二个命名空间的只剩两个消费点，且只用于 `@fenix/ui-components` 自有词条（见下方断言）。

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
 *
 * 上调到 315（2026-09-24 台账 D4）：站点与重启词条 78 键迁入（`siteDeployment` 48 / `panelMode` 14 /
 * `siteFrame` 11 / 编辑器重启 5），228 + 78 = 306…——注意 228 是上一轮的下界而非当时实际键数
 * （实际 237），故这次把基线拉回实测值：237 + 78 = 315。
 *
 * 上调到 318（2026-09-25，D4 补迁）：端口 `translatePanel` 消费的三条重启结果文案一并归位，315 + 3 = 318。
 *
 * 上调到 319（2026-09-25，D2 收尾）：站点取数 hook `use-artifacts-sites.ts` 从宿主壳迁入本包
 * （前端规范 §2.5「壳不做取数」+ §10.5.2「hook 归所属模块」），它消费的 `panelMode.unmountFailed`
 * 随之归位——宿主 `components` 字典里的同名副本已删除。318 + 1 = 319。
 *
 * 上调到 329（2026-09-28，侧栏智能体树迁入）：宿主壳的智能体树取数与四种领域操作（进入 / 重启 /
 * 停止 / 删除）按 §2.5「壳不做取数」迁入本包 `web/hooks/use-agent-sidebar-tree.ts`，两个确认弹窗
 * 与全部结果提示随之落到本包字典：重启弹窗 3 键（`restartTitle` / `restartDescription` / `selectAll`）、
 * 动作结果 5 键（`restartFailed` / `stopSuccess` / `stopInstanceFailed` / `deleteSuccess` / `deleteFailed`）、
 * 删除确认 2 键（`deleteAgentTitle` / `deleteAgentConfirm`），共 10 键——进入失败复用既有
 * `enterFailed`，不复制同义键。319 + 10 = 329。
 *
 * 下调到 311（2026-10-09，编辑器右栏改版）：右栏「当前配置」汇总栏整栏删除、头部「从模板构建」
 * 按钮随模板列表改为常驻面板，两者独占的 18 个键一并删除（`configurationOverview`、`summary*` 15 个、
 * `buildFromTemplate`）。`defaultRuntime` 不在其中：它同时是运行环境分区默认节点的说明
 * （`use-agent-editor.ts` 的 `description`），只随汇总栏一起失去了一个消费点。
 * 与 2026-09-22 那次同理：删的是**全仓零引用的死键**，不是「本包消费的键」，故保留原判据
 * （仍为下界断言，继续拦住静默缩水）。329 - 18 = 311。
 */
const MIGRATED_KEY_BASELINE = 311;

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
 * 台账 D4 前这里还登记了七个「键的 owner 在宿主」的站点文件；那批键迁入本包后条目全部删除——
 * 留着等于给下一条跨包借键预留后门。剩下的三个条目都是「键的 owner 已在本包但属于另一个命名空间」
 * （`dashboard` / `agentHome`，其字典由下面独立的断言守护）。每个条目都带「期望命名空间」，断言会校验
 * 该文件确实在用这个命名空间——登记是显式状态而不是扫描漏网；文件改用 `agents` 命名空间时这条断言会先
 * 变红，强制重新评审。
 *
 * 站点组件里仍存在的第二个命名空间绑定（`@fenix/ui-components` 的 `confirmDialog.cancel` /
 * `statusBadge.all`）不在此登记：它们的取键函数是 `tUi(...)` / `tc(...)`，不参与 `\bt("…")` 字面量
 * 扫描，因此登记它们只会让本包自己的 `panelMode.*` / `siteDeployment.*` 字面量漏检。这类绑定改由
 * 下方「第二个命名空间绑定只有组件库词条的消费点」逐文件钉住。
 */
const OTHER_NAMESPACE_FILES: ReadonlyArray<{ file: string; namespace: string; reason: string }> = [
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
];

/**
 * 唯一允许绑 `@fenix/ui-components` 命名空间的两个消费点（台账 D4）：取的是该包自有词条
 * `confirmDialog.cancel`（`ConfirmDialog` 的默认取消文案）与 `statusBadge.all`（筛选条的「全部」）。
 * 两处宿主同名键是组件库词条的副本，本包不复制、只引用，故不进本包字典。
 */
const UI_COMPONENTS_BINDING_FILES: readonly string[] = [
  "components/agent-panel/MountSiteDialog.tsx",
  "pages/agent-panel/pages/AgentManagementPage.tsx",
];

/**
 * 台账 D4 从宿主两份字典迁入本包的键组：组名 → 该组的叶子键数（宿主侧同名组已被删除）。
 * 逐个点名而不是只断言总数，因为「少迁一个键」在宿主删除后同样只会让界面静默回显 key。
 */
const MIGRATED_GROUPS: ReadonlyArray<readonly [string, number]> = [
  ["siteDeployment", 48],
  ["panelMode", 15],
  ["siteFrame", 11],
];

/** 同批迁入的顶层散键（编辑器「配置已保存，是否重启」流程与重启动作按钮）。 */
const MIGRATED_SCALARS: readonly string[] = [
  "restarting",
  "restartConfirm",
  "restartLater",
  "configSavedRestartTitle",
  "configSavedRestartDescription",
  // 2026-09-25 补迁（D4 漏项）：这三条重启结果文案的消费点在 `use-agent-editor.ts`，取键函数是端口
  // `translatePanel`（`tp(`）而不是 `t(`，因此上一批的迁移清单与扫描都没看见它们，D4 改绑命名空间后
  // 三处 toast 静默回显 key。补迁后由下方「端口与别名消费的字面量键」守卫继续兜底。
  "restartSuccess",
  "restartFailedSaved",
  "noInstancesToRestart",
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

/** `@fenix/ui-components` 自有词条的 en 字典：本包只引用不复制（见 `UI_COMPONENTS_BINDING_FILES`）。 */
const uiComponentsEnFlat = flatten(
  JSON.parse(
    readFileSync(resolve(WEB_ROOT, "../../../ui-components/web/i18n/locales/en/uiComponents.json"), "utf8"),
  ) as Record<string, unknown>,
);

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

  // 端口与别名消费的键在 `t("…")` 扫描之外：编辑器的 `translate` / `translatePanel` 端口由
  // `agent-editor-body.tsx` 绑定 `NS.AGENTS`，消费点（`use-agent-editor.ts` 的 `tp(…)`、站点组件的
  // `tUi` / `tc`）与绑定点分属不同文件，`tsc` 也看不见——端口类型是 `(key: string) => string`。
  // 2026-09-25 实测的回归正是这一类：三键留在宿主而端口已改绑 `agents`，三处 toast 静默回显 key。
  // 判据：所有翻译函数调用的字面量键必须能在本包三份字典或组件库词条里查到；别名形状用宽松匹配
  // （`t` / `tp` / `tc` / `tXxx` / `xxxTranslate`，覆盖后续新增别名），`toast.error("…")` 这类非翻译
  // 调用被前置字符与首字母大小写规则挡掉。
  test("端口与别名消费的字面量键都在字典内", () => {
    const dictionaries = [enFlat, agentHomeEnFlat, dashboardEnFlat, uiComponentsEnFlat];
    const callPattern = /(?<![\w$.])(t|tp|tc|t[A-Z]\w*|translate\w*|\w*[Tt]ranslate\w*)\(\s*"([^"]+)"/g;
    const missing: string[] = [];
    let scanned = 0;
    for (const file of collectSources(WEB_ROOT)) {
      const relPath = relative(WEB_ROOT, file);
      for (const match of readFileSync(file, "utf8").matchAll(callPattern)) {
        scanned += 1;
        if (!dictionaries.some((dict) => dict.has(match[2]))) missing.push(`${relPath}: ${match[1]}("${match[2]}")`);
      }
    }
    expect(missing).toEqual([]);
    // 扫描有效性自检：命中数骤降说明正则或目录遍历被改坏，此时上面那条空数组断言会静默通过。
    expect(scanned).toBeGreaterThanOrEqual(300);
  });

  // 登记表必须与源码一致：文件仍在使用声明的命名空间，键不会两头落空。
  test("登记绑定其他命名空间的文件确实在用该命名空间", () => {
    const drifted = OTHER_NAMESPACE_FILES.filter(
      (entry) => !readFileSync(join(WEB_ROOT, entry.file), "utf8").includes(`useTranslation(${entry.namespace})`),
    );
    expect(drifted.map((entry) => `${entry.file} 未使用 ${entry.namespace}`)).toEqual([]);
  });

  // 台账 D4 的迁移结果：宿主两份字典里被本包消费的键一个不少地落进 `agents`，宿主侧只删不留。
  // 组内叶子数与散键都点名，因为少迁一个键在宿主删除后同样只会让界面静默回显 key。
  test("D4 迁入的键组与散键齐备", () => {
    for (const [group, expected] of MIGRATED_GROUPS) {
      const leaves = [...enFlat.keys()].filter((key) => key.startsWith(`${group}.`));
      expect(leaves.length, `${group} 组叶子数`).toBe(expected);
      expect([...zhFlat.keys()].filter((key) => key.startsWith(`${group}.`)).length).toBe(expected);
    }
    for (const key of MIGRATED_SCALARS) {
      expect(enFlat.has(key), `en 缺 ${key}`).toBe(true);
      expect(zhFlat.has(key), `zh 缺 ${key}`).toBe(true);
    }
  });

  // 其他命名空间的键组不得被复制进本包字典：同一批键两边各存一份会让 host 侧删除静默打断本包界面，
  // 也违反「键的最终所在地 = 包的 owner」。`siteDeployment` / `panelMode` / `siteFrame` 在 D4 后已是
  // 本包自持的键组（组名沿用宿主原名，便于对照迁移映射），故从外来的组名清单里移出；`statusBadge`
  // 是本批唯一新增的外来组名（其 owner 是 `@fenix/ui-components` 的 `StatusBadge`，本包只引用不复制）。
  // 本包自有的 `resource.*`（编辑器可见性说明，与共享包的同名角标组语义不同）不在此列。
  test("其他命名空间的键组没有复制进本包字典", () => {
    const foreignGroups = ["confirmDialog", "statusBadge", "sidebar", "dashboard"];
    const duplicated = foreignGroups.filter((group) => enFlat.has(`${group}.x`) || Object.hasOwn(EN, group));
    expect(duplicated).toEqual([]);
  });

  // 台账 D4 的直接回归点：宿主 `components` / `agentPanel` 的借用口全部关闭。宿主那两个命名空间仍在
  // 宿主字典里登记（宿主壳自用），因此只要本包还有一处绑它们，就说明又出现了「键的 owner 与消费方
  // 分属两侧」的旧形态。
  test("包内不再绑定宿主 components / agentPanel 命名空间", () => {
    const offenders = collectSources(WEB_ROOT)
      .filter((file) => /useTranslation\(\s*NS\.(COMPONENTS|AGENT_PANEL)\s*\)/.test(readFileSync(file, "utf8")))
      .map((file) => relative(WEB_ROOT, file));
    expect(offenders).toEqual([]);
  });

  // 允许存在的第二个命名空间绑定只有组件库词条的两个消费点（见常量说明）：多一处即说明本包又借了
  // 别人的字典，少一处则说明词条 owner 变了，两种情况都要重新评审。
  test("绑定 ui-components 命名空间的消费点只有组件库词条两处", () => {
    const bound = collectSources(WEB_ROOT)
      .filter((file) => readFileSync(file, "utf8").includes("useTranslation(NS.UI_COMPONENTS)"))
      .map((file) => relative(WEB_ROOT, file))
      .sort();
    expect(bound).toEqual([...UI_COMPONENTS_BINDING_FILES].sort());
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
