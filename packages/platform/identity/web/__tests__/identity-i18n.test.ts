// web/__tests__/identity-i18n.test.ts
// 守护 identity 三份字典（apikey / orgs / settings）的完整性，以及「键的最终所在地 = 包的 owner」这条归属约束。
//
// 为什么必须静态断言：i18next 缺键时回退成「显示 key 本身」，界面不报错，只有中英文来回切换才暴露。
// 这里直接读 JSON 文件（不经过 i18next 单例），因此不受测试里 react-i18next 模块 mock 的影响
// ——宿主测试曾因 mock 让 t() 回显 key，掩盖过真实的缺键。
//
// T4 期间的「借宿主命名空间的键」债务已由 T9（§1.6 i18n 归属重划）结清：
// `ChangePasswordDialog` 的 11 个键随 `git mv` 从宿主 `locales/*/settings.json` 落到本包
// `locales/*/settings.json`，`OrgContext` 的 `orgSwitchFailed` 从宿主 `components` 命名空间搬入本包
// `orgs.json`。因此本文件不再有借键白名单：字面量键必须**全部**落在本包三份字典内（下面的断言直接
// 检查这一点），宿主也不再注册 `settings` 的宿主副本、不再持有 `components.orgSwitchFailed`。

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
const SETTINGS_EN = readJson("settings", "en");
const SETTINGS_ZH = readJson("settings", "zh");

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
const SETTINGS_EN_FLAT = flatten(SETTINGS_EN);
const SETTINGS_ZH_FLAT = flatten(SETTINGS_ZH);
/** 本包自持键的并集：三个命名空间的键互不重叠，合并后用于字面量扫描。 */
const OWNED = new Map([...APIKEY_EN_FLAT, ...ORGS_EN_FLAT, ...SETTINGS_EN_FLAT]);

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

  // settings 同理（T9 从宿主搬入的第三份字典）。
  test("settings 的 en / zh 键集完全一致", () => {
    expect([...SETTINGS_ZH_FLAT.keys()].sort()).toEqual([...SETTINGS_EN_FLAT.keys()].sort());
    expect(SETTINGS_EN_FLAT.size).toBeGreaterThanOrEqual(11);
  });

  // 插值占位符必须成对出现，否则某一语言会把 {{var}} 当字面量显示出来。
  test("同一键在 en / zh 的插值占位符一致", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    for (const [en, zh] of [
      [APIKEY_EN_FLAT, APIKEY_ZH_FLAT],
      [ORGS_EN_FLAT, ORGS_ZH_FLAT],
      [SETTINGS_EN_FLAT, SETTINGS_ZH_FLAT],
    ] as const) {
      const mismatched = [...en.keys()].filter(
        (key) => JSON.stringify(placeholders(en.get(key) ?? "")) !== JSON.stringify(placeholders(zh.get(key) ?? "")),
      );
      expect(mismatched).toEqual([]);
    }
  });

  // 源码里所有字面量键都必须落在本包字典内：T9 结清借键债务后不再有白名单，
  // 任何越界键都会在这里失败（漏键 = 界面显示 key）。
  test("源码中的字面量 t() 键都在字典内", () => {
    const missing = [...literalKeys.keys()].filter((key) => !OWNED.has(key));
    expect(missing).toEqual([]);
    // 扫描有效性自检：键数骤降通常意味着扫描路径被改坏，而不是文案变少了。
    expect(literalKeys.size).toBeGreaterThanOrEqual(100);
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
    const { APIKEY_NS, ORGS_NS, SETTINGS_NS, apikeyResources, orgResources, settingsResources } = await import(
      "../i18n"
    );
    expect(APIKEY_NS).toBe(NS.APIKEY);
    expect(ORGS_NS).toBe(NS.ORGS);
    expect(SETTINGS_NS).toBe(NS.SETTINGS);
    expect([APIKEY_NS, ORGS_NS, SETTINGS_NS]).toEqual(["apikey", "orgs", "settings"]);
    expect(apikeyResources.en).toEqual(APIKEY_EN);
    expect(orgResources.zh).toEqual(ORGS_ZH);
    expect(settingsResources.zh).toEqual(SETTINGS_ZH);
  });

  // 字典路径是 `web/i18n/index.ts` 的 import 契约：宿主已改为经 `./web/i18n` 出口取符号，
  // 路径漂移会让出口解析失败（启动期即崩），因此这里钉住「出口指向同一批文件」。
  test("web/i18n 出口指向同一批 JSON，且不引用宿主路径", () => {
    const entrySource = readFileSync(join(I18N_ROOT, "index.ts"), "utf8");
    for (const name of ["apikey", "orgs", "settings"]) {
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
