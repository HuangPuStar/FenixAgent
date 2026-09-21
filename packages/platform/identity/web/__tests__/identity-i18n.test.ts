// web/__tests__/identity-i18n.test.ts
// 守护 identity 两份字典（apikey / orgs）的完整性，以及「键的最终所在地 = 包的 owner」这条归属约束。
//
// 为什么必须静态断言：i18next 缺键时回退成「显示 key 本身」，界面不报错，只有中英文来回切换才暴露。
// 这里直接读 JSON 文件（不经过 i18next 单例），因此不受测试里 react-i18next 模块 mock 的影响
// ——宿主测试曾因 mock 让 t() 回显 key，掩盖过真实的缺键。
//
// 已知债务（不属于本文件，归 stage-2 计划 §1.6 的 T9「i18n 归属重划」）：
// `components/ChangePasswordDialog.tsx` 读的是宿主 `NS.SETTINGS`（11 个键全在
// `apps/web/src/i18n/locales/{en,zh}/settings.json`），`contexts/OrgContext.tsx` 读的是宿主
// `NS.COMPONENTS`（键 `orgSwitchFailed`）。两处都是「本包的组件借宿主命名空间的键」——键的物理落点
// 与 owner 不一致。T4 只做别名归零与字典落位，不搬这两个文件；下面的 BORROWED_KEYS 把它们显式登记，
// 并反向断言「这些键此刻不在本包字典里」，于是 T9 真把键搬进本包时本文件会立即失败，
// 迫使白名单与债务注释一起删除，而不会留下一条「已搬迁但仍被豁免」的静默通道。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { NS } from "@fenix/web-runtime/i18n/namespace";

const WEB_ROOT = resolve(import.meta.dir, "..");
const I18N_ROOT = join(WEB_ROOT, "i18n");

const APIKEY_EN = readJson("apikey", "en");
const APIKEY_ZH = readJson("apikey", "zh");
const ORGS_EN = readJson("orgs", "en");
const ORGS_ZH = readJson("orgs", "zh");

function readJson(name: string, lng: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(I18N_ROOT, "locales", lng, `${name}.json`), "utf8")) as Record<string, unknown>;
}

/** 把嵌套字典摊平成点号路径：`form.name`、`machineStatus.online`，顶层键保持原样。 */
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

const sources = collectSources(WEB_ROOT);
const APIKEY_EN_FLAT = flatten(APIKEY_EN);
const APIKEY_ZH_FLAT = flatten(APIKEY_ZH);
const ORGS_EN_FLAT = flatten(ORGS_EN);
const ORGS_ZH_FLAT = flatten(ORGS_ZH);
/** 本包自持键的并集：两个命名空间的键互不重叠，合并后用于字面量扫描。 */
const OWNED = new Map([...APIKEY_EN_FLAT, ...ORGS_EN_FLAT]);

/**
 * 源码里出现的全部字面量 `t("key")`，记录它出现在哪些文件（动态键如 `` t(`roles.${role}`) `` 由下面的
 * 键族断言覆盖，字面量扫描看不到）。
 */
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

/** T9 债务的精确登记：文件 → 它向宿主命名空间借的键（这些键此刻不得出现在本包字典里）。 */
const BORROWED_KEYS: Record<string, readonly string[]> = {
  "components/ChangePasswordDialog.tsx": [
    "changeFailed",
    "changePassword",
    "changePasswordDesc",
    "changeSuccess",
    "confirmPassword",
    "currentPassword",
    "newPassword",
    "passwordsMismatch",
    "passwordTooShort",
    "pleaseWait",
    "unknownError",
  ],
  "contexts/OrgContext.tsx": ["orgSwitchFailed"],
};

/** 白名单展平成 键 → 借它的文件，便于两个方向同时断言。 */
const borrowedIndex = new Map<string, string>();
for (const [file, keys] of Object.entries(BORROWED_KEYS)) {
  for (const key of keys) borrowedIndex.set(key, file);
}

describe("identity 字典完整性", () => {
  // apikey 两份字典键集必须逐字一致：缺键的语言会静默回显 key。
  test("apikey 的 en / zh 键集完全一致", () => {
    expect([...APIKEY_ZH_FLAT.keys()].sort()).toEqual([...APIKEY_EN_FLAT.keys()].sort());
    expect(APIKEY_EN_FLAT.size).toBeGreaterThanOrEqual(30);
  });

  // orgs 同理；规模底线防止「整段字典被误删但仍通过一致性检查」。
  test("orgs 的 en / zh 键集完全一致", () => {
    expect([...ORGS_ZH_FLAT.keys()].sort()).toEqual([...ORGS_EN_FLAT.keys()].sort());
    expect(ORGS_EN_FLAT.size).toBeGreaterThanOrEqual(110);
  });

  // 插值占位符必须成对出现，否则某一语言会把 {{var}} 当字面量显示出来。
  test("同一键在 en / zh 的插值占位符一致", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    for (const [en, zh] of [
      [APIKEY_EN_FLAT, APIKEY_ZH_FLAT],
      [ORGS_EN_FLAT, ORGS_ZH_FLAT],
    ] as const) {
      const mismatched = [...en.keys()].filter(
        (key) => JSON.stringify(placeholders(en.get(key) ?? "")) !== JSON.stringify(placeholders(zh.get(key) ?? "")),
      );
      expect(mismatched).toEqual([]);
    }
  });

  // 源码里所有字面量键都必须落在本包字典内，白名单外的缺失一律失败（漏键 = 界面显示 key）。
  test("源码中的字面量 t() 键都在字典内（扣除 T9 借键白名单）", () => {
    const missing = [...literalKeys.keys()].filter((key) => !OWNED.has(key) && !borrowedIndex.has(key));
    expect(missing).toEqual([]);
    // 扫描有效性自检：键数骤降通常意味着扫描路径被改坏，而不是文案变少了。
    expect(literalKeys.size).toBeGreaterThanOrEqual(100);
  });

  // 借键白名单必须与实测完全吻合：既要覆盖全部越界键，也不得留下已经不再出现的键，
  // 否则白名单会随时间腐化成一张「什么都放行」的通行证。
  test("借键白名单与实测的越界键逐一吻合", () => {
    const actualBorrowed = [...literalKeys.keys()].filter((key) => !OWNED.has(key));
    expect(actualBorrowed.sort()).toEqual([...borrowedIndex.keys()].sort());
    for (const [key, file] of borrowedIndex) {
      // 同一键可在同一文件里出现多次（如 `changePassword` 既是对话框标题也是按钮文案），去重后判断归属。
      expect([...new Set(literalKeys.get(key))]).toEqual([file]);
    }
  });

  // T9 债务的移除条件：借的键此刻**不在**本包字典里。T9 把键搬进本包后这条先失败，
  // 提醒删除 BORROWED_KEYS 与文件头的债务注释，而不是让两处同时存在（那才是真正的双份真相）。
  test("借键此刻不属于本包字典（T9 搬迁后本断言将失败，以驱动删除白名单）", () => {
    for (const key of borrowedIndex.keys()) {
      expect(OWNED.has(key)).toBe(false);
    }
  });

  // 动态键族无法被字面量扫描覆盖，逐个点名：漏一个就是界面上多出一串 key。
  // roles.* 与 machineStatus.* 直接内插变量；*MachineDialog.* 由 MachineFields 的 prefix 参数拼接。
  test("动态键族齐备（角色、机器状态、机器表单两套前缀）", () => {
    for (const key of ["roles.owner", "roles.admin", "roles.member", "machineStatus.online", "machineStatus.offline"]) {
      expect(ORGS_EN_FLAT.has(key)).toBe(true);
      expect(ORGS_ZH_FLAT.has(key)).toBe(true);
    }
    for (const prefix of ["createMachineDialog", "editMachineDialog"]) {
      for (const suffix of ["name", "namePlaceholder", "labels", "labelsPlaceholder", "agentName"]) {
        expect(ORGS_EN_FLAT.has(`${prefix}.${suffix}`)).toBe(true);
        expect(ORGS_ZH_FLAT.has(`${prefix}.${suffix}`)).toBe(true);
      }
    }
  });

  // 键归属：字典里不得出现带命名空间前缀的寄居键（`orgs.` / `apikey.`），也不得混入别的命名空间的
  // 前缀（`settings.` / `components.`）——那是 T9 说的「键的最终所在地 = 包的 owner」被打破的形态。
  test("字典中不存在带命名空间前缀的寄居键", () => {
    const foreign = [...OWNED.keys()].filter((key) => /^(orgs|apikey|settings|components|common)\./.test(key));
    expect(foreign).toEqual([]);
  });
});

describe("identity i18n 出口契约", () => {
  // 命名空间常量必须与中心表同值：宿主注册字典时按的是同一张表，两处字面量分歧的症状是
  // 整片文案回退成 key 回显，且构建期不可见。
  test("命名空间常量等于共享 NS 表的取值，且与字典文件名一致", async () => {
    const { APIKEY_NS, ORGS_NS, apikeyResources, orgResources } = await import("../i18n");
    expect(APIKEY_NS).toBe(NS.APIKEY);
    expect(ORGS_NS).toBe(NS.ORGS);
    expect([APIKEY_NS, ORGS_NS]).toEqual(["apikey", "orgs"]);
    expect(apikeyResources.en).toEqual(APIKEY_EN);
    expect(orgResources.zh).toEqual(ORGS_ZH);
  });

  // 字典路径是 `web/i18n/index.ts` 的 import 契约：宿主已改为经 `./web/i18n` 出口取符号，
  // 路径漂移会让出口解析失败（启动期即崩），因此这里钉住「出口指向同一批文件」。
  test("web/i18n 出口指向同一批 JSON，且不引用宿主路径", () => {
    const entrySource = readFileSync(join(I18N_ROOT, "index.ts"), "utf8");
    for (const name of ["apikey", "orgs"]) {
      for (const lng of ["en", "zh"]) {
        expect(statSync(join(I18N_ROOT, "locales", lng, `${name}.json`)).isFile()).toBe(true);
        expect(entrySource).toContain(`./locales/${lng}/${name}.json`);
      }
    }
    expect(entrySource).not.toContain("../src/");
    expect(entrySource).not.toMatch(/from\s+"@\//);
  });

  // 包出口是宿主的解析入口：`./web/i18n` 缺失或指错文件时，宿主的 i18n 引导会在启动期崩，
  // 而包内测试全绿——所以这条必须在包内钉住。
  test("package.json 的 ./web/i18n 出口指向 web/i18n/index.ts", () => {
    const pkg = JSON.parse(readFileSync(resolve(WEB_ROOT, "..", "package.json"), "utf8")) as {
      exports?: Record<string, { types?: string; default?: string }>;
    };
    expect(pkg.exports?.["./web/i18n"]).toEqual({
      types: "./web/i18n/index.ts",
      default: "./web/i18n/index.ts",
    });
  });
});
