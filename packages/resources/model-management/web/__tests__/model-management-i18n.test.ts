// web/__tests__/model-management-i18n.test.ts
// 守护本包 i18n 字典的完整性与归属（计划 §4：键的最终所在地 = 包的 owner）。
//
// 背景：本包原先没有自己的 i18n 目录，三批键分别寄居在宿主 `models` 命名空间、observer 命名空间的
// `modelGateway.*` 组、宿主 `components` 命名空间的 `modelConfig.*` 组。本次迁移后它们合并进本包的
// `web/i18n/locales/{en,zh}/models.json`，本文件把「迁出方删了、迁入方必须有」变成可执行断言：
//   - `modelGateway.*` 的 171 个键来自稳定快照 `git show HEAD:packages/resources/observer/...`，
//     数量在此钉死，任何一次「读工作区文件导致漏键」都会当场变红；
//   - 宿主 `models` 命名空间的 41 组 200 个键原样迁入（宿主侧同批只删除，不再保留副本）。
//
// 字典是 JSON，路径是宿主契约：宿主注册切换到本包后按 `web/i18n/locales/{en,zh}/models.json` 这两个
// 路径 import（今天宿主仍读本地副本，切换属 §4 共享文件的临时 patch），因此**路径与文件名不得更改**，
// 改名会让宿主在启动期拿不到字典并整页回显 key。
//
// 扫描口径：只检查引用了本包命名空间常量 `MODELS_NS` 的源码文件。键与命名空间同文件绑定，因此
// 「文件用哪个命名空间」就决定了「它的字面量键属于哪本字典」——不按文件过滤会把宿主 `agentPanel`
// 等其他命名空间的同名键误判成缺键。模板字面量键（``t(`prefix.${x}`)``）静态扫不到，逐条钉在下面。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { MODELS_NS } from "../i18n/namespace";

const WEB_ROOT = join(import.meta.dir, "..");
const DICT_DIR = join(WEB_ROOT, "i18n", "locales");
const en = readJson(join(DICT_DIR, "en", "models.json"));
const zh = readJson(join(DICT_DIR, "zh", "models.json"));

type Dict = Record<string, unknown>;

function readJson(path: string): Dict {
  return JSON.parse(readFileSync(path, "utf8")) as Dict;
}

/** 展开成 `a.b.c` 扁平键集合；数组与数字等非对象值也计为叶子（本包字典目前只有字符串叶子）。 */
function flatten(value: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const [key, child] of Object.entries(value as Dict)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      for (const nested of flatten(child, path)) out.add(nested);
    } else {
      out.add(path);
    }
  }
  return out;
}

/** 递归收集 `web/**` 下的源码文件（跳过字典与测试自身）。 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "i18n") continue;
      found.push(...sourceFiles(path));
    } else if ([".ts", ".tsx"].includes(extname(entry.name))) {
      found.push(path);
    }
  }
  return found;
}

/** 取点号路径的叶子值：只用于比对插值占位符，非字符串叶子一律返回空串。 */
function leafValue(dict: Dict, key: string): string {
  let current: unknown = dict;
  for (const segment of key.split(".")) {
    if (current === null || typeof current !== "object") return "";
    current = (current as Dict)[segment];
  }
  return typeof current === "string" ? current : "";
}

const enKeys = flatten(en);
const zhKeys = flatten(zh);
const sources = sourceFiles(WEB_ROOT).map((path) => ({
  path: relative(WEB_ROOT, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

/** 引用了本包命名空间常量的文件：它们的字面量键落在本包字典里。 */
const ownNamespaceSources = sources.filter((file) => file.text.includes("MODELS_NS"));
/** 字面量键（模板拼接与 `ns:key` 形式由其他断言覆盖）。 */
const literalKeys = new Set<string>();
for (const file of ownNamespaceSources) {
  for (const match of file.text.matchAll(/\bt\(\s*"([^"]+)"/g)) {
    if (!match[1].includes("${") && !match[1].includes(":")) literalKeys.add(match[1]);
  }
}

describe("本包 i18n 字典（models 命名空间）", () => {
  // 扫描有效性自检：正则或过滤条件写错会退化成空集合，后面的断言全部假绿。
  test("扫描有效性自检：本包命名空间文件与字面量键都非空", () => {
    expect(ownNamespaceSources.length).toBeGreaterThanOrEqual(8);
    expect(literalKeys.size).toBeGreaterThanOrEqual(200);
  });

  // en/zh 键集合必须完全一致：缺一侧会让该语言整片界面回退为 key 回显。
  test("en 与 zh 的扁平键集合完全一致", () => {
    expect([...enKeys].sort()).toEqual([...zhKeys].sort());
  });

  // 同一键的插值占位符必须成对出现：某一语言漏写 `{{var}}` 时 i18next 会把变量当字面文本丢掉，
  // 界面不报错、只有切换语言才看得出来（形状照抄黄金样本 sandbox 的同名用例）。
  test("en 与 zh 同一键的插值占位符一致", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    const interpolated = [...enKeys].filter((key) => /\{\{\w+\}\}/.test(leafValue(en, key)));
    const mismatched = interpolated.filter(
      (key) => JSON.stringify(placeholders(leafValue(en, key))) !== JSON.stringify(placeholders(leafValue(zh, key))),
    );
    // 自检：占位符键为 0 会让断言退化成恒真。
    expect(interpolated.length).toBeGreaterThan(0);
    expect(mismatched).toEqual([]);
  });

  // 迁移体量钉死：这三组是本次从别处收回的键，数量即「迁出方删除后迁入方不丢键」的证据。
  test("迁入键组数量与迁移来源一致（modelGateway 171 / modelConfig 8 / admin 2）", () => {
    const count = (set: Set<string>, prefix: string) => [...set].filter((key) => key.startsWith(`${prefix}.`)).length;
    expect(count(enKeys, "modelGateway")).toBe(171);
    expect(count(enKeys, "modelConfig")).toBe(8);
    expect(count(enKeys, "admin")).toBe(2);
    expect(count(zhKeys, "modelGateway")).toBe(171);
    expect(count(zhKeys, "modelConfig")).toBe(8);
    expect(count(zhKeys, "admin")).toBe(2);
    // 宿主 `models` 命名空间的 41 组 200 键原样迁入；加上三组迁入键共 381 个叶子；
    // 本次（任务 1.3 缺口修复）再新增 5 个状态/可访问名键（`gateway.forbidden` +
    // `verticalModels.{searchLabel,emptyTitle,emptyDescription,clearSearch}`）共 386；
    // §1.6 T11b2 侧栏导航随项下沉再新增 `nav.{models,algorithms,verticalModels}` 3 键共 389
    // （文案逐字取自宿主 `agentPanel` 的同名键，见 `web/contribution.ts`）。
    expect(enKeys.size).toBe(389);
    expect(zhKeys.size).toBe(389);
  });

  // 字典内不得再嵌一层命名空间前缀：宿主按 MODELS_NS 注册本文件，多一层前缀会让所有键变成 key 回显。
  test("字典内不存在嵌套的命名空间前缀键", () => {
    const nested = [...enKeys].filter((key) => /^(models|observer|sandbox|components|common|agentPanel)\./.test(key));
    expect(nested).toEqual([]);
  });

  // 源码里的字面量键必须都在字典内（漏一条就是界面上的一处 key 回显）。
  test("源码中的字面量 t() 键都在字典内", () => {
    const missing = [...literalKeys].filter((key) => !enKeys.has(key) || !zhKeys.has(key));
    expect(missing).toEqual([]);
  });

  // 模板字面量动态键（静态扫描覆盖不到）逐条钉住：取值域来自源码里的封闭枚举
  // （`SCOPES`、`ProviderInfo["protocol"]`、`ModelSyncChange["kind"]`、密钥不可用原因码、用量主体类型）。
  test("模板字面量动态键齐备", () => {
    for (const key of [
      "scope.all",
      "scope.organization",
      "scope.public",
      "protocolOptions.anthropic",
      "protocolOptions.openai",
      "testStatus.error",
      "testStatus.running",
      "testStatus.success",
      "modelGateway.tabs.budgets",
      "modelGateway.tabs.keys",
      "modelGateway.tabs.models",
      "modelGateway.tabs.overview",
      "modelGateway.tabs.usage",
      "modelGateway.change.added",
      "modelGateway.change.removed",
      "modelGateway.change.updated",
      "modelGateway.usagePage.filters.agent",
      "modelGateway.usagePage.filters.model",
      "modelGateway.usagePage.filters.organization",
      "modelGateway.usagePage.filters.user",
      "modelGateway.keysPage.reasons.usable",
      "modelGateway.keysPage.reasons.unusable",
      "modelGateway.keysPage.reasons.AGENT_ACCESS_REVOKED",
      "modelGateway.keysPage.reasons.AGENT_NOT_FOUND",
      "modelGateway.keysPage.reasons.CREDENTIAL_UNUSABLE",
      "modelGateway.keysPage.reasons.MEMBERSHIP_NOT_FOUND",
      "modelGateway.keysPage.reasons.ORGANIZATION_NOT_FOUND",
      "modelGateway.keysPage.reasons.USER_NOT_FOUND",
    ]) {
      expect(enKeys.has(key)).toBe(true);
      expect(zhKeys.has(key)).toBe(true);
    }
  });

  // 字典文件路径是宿主契约：宿主注册改指本包后按这两个相对路径 import（§4 共享文件，本包切片不改），
  // 改名或挪目录会让宿主启动期拿不到字典。
  test("字典文件保持在 web/i18n/locales/{en,zh}/models.json", () => {
    expect(readJson(join(DICT_DIR, "en", "models.json"))).toBeObject();
    expect(readJson(join(DICT_DIR, "zh", "models.json"))).toBeObject();
    expect(enKeys.size).toBeGreaterThan(0);
  });

  // 命名空间字面量必须与字典文件名、宿主注册名三处一致（`NS.MODELS`）。
  test("命名空间字面量取自共享 NS 表且与文件名一致", () => {
    expect(MODELS_NS).toBe("models");
  });

  // 包内页面只读本包命名空间与宿主 `agentPanel`（侧边栏/页面标题文案由宿主与 agent-config 的导航共享，
  // 迁走会让宿主导航缺键）。出现第三个命名空间即说明包内又寄居了别人的键。
  test("包内页面只使用本包命名空间与宿主 agentPanel", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const match of file.text.matchAll(/useTranslation\(\s*([^)]*?)\s*\)/g)) {
        const arg = match[1];
        if (arg === "" || arg.includes("MODELS_NS") || arg.includes("NS.AGENT_PANEL")) continue;
        offenders.push(`${file.path} → useTranslation(${arg})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
