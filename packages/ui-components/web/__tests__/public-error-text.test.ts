// web/__tests__/public-error-text.test.ts
// 守护「公开错误正文按 type 取本地化文案」的三条不变量：
// 1. 内联契约的 `PublicErrorType` 取值集合与字典 `chat.components.publicError.*` 的键集合逐一对应——
//    少一个键就是 key 回显或静默退回英文；多一个键就是 T9c 清过 684 条的那类死键（协议删了 type，
//    字典没跟上）。
// 2. 每个键的 zh 不是 en 的照抄（键集一致时，漏译完全静默）。
// 3. `publicErrorText` 的键推导与回退语义：命中取字典、未登记 type 退回 wire 摘要、绝不回显 key。
//
// 断言一律走注入的桩 `t`（记录 key + 查扁平字典），不初始化 i18next 单例：宿主测试曾因同进程其他
// 文件对 `react-i18next` 的模块 mock 残留，让 `t()` 在真实实例下也回显 key，本文件不依赖进程内
// i18n 状态。三、四两条也顺带把「键前缀」钉在断言里。
//
// 为什么要这一份：`PublicError.message` 是 wire 与日志字段且恒为英文（`isPublicError` 以它做帧
// 完整性校验），界面改按 `type` 取字典后，「字典是否覆盖全部 type」就成了新的失败模式——漏一个
// type 只会在那一种故障下退回英文，人工审计几乎不可能发现。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TFunction } from "i18next";
import { publicErrorText } from "../chat/view/public-error-text";

const WEB_ROOT = resolve(import.meta.dir, "..");
const KEY_PREFIX = "chat.components.publicError.";

const EN = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/en/uiComponents.json"), "utf8")) as Record<
  string,
  unknown
>;
const ZH = JSON.parse(readFileSync(join(WEB_ROOT, "i18n/locales/zh/uiComponents.json"), "utf8")) as Record<
  string,
  unknown
>;

/** 把嵌套字典摊平成点号路径（与 `i18n-barrel.test.ts` 同口径）。 */
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

const enFlat = flatten(EN);
const zhFlat = flatten(ZH);
const dictKeys = [...enFlat.keys()].filter((key) => key.startsWith(KEY_PREFIX)).sort();

/**
 * 从内联契约源码取 `PublicErrorType` 的取值集合。
 *
 * 本包对 chat 契约整体「逐字内联」（见 `web/chat/internal/types-chat-projection.ts` 头注），不 import
 * `@fenix/chat-channel`；因此 union 字面量就是包内唯一真相，直接读源码而不是在测试里再抄一份清单——
 * 抄一份就等于多一处会漂移的第二真相，且协议新增 type 时测试不会跟着变。
 */
function readInlinedTypes(): string[] {
  const source = readFileSync(join(WEB_ROOT, "chat/internal/types-chat-projection.ts"), "utf8");
  const declaration = source.slice(source.indexOf("export type PublicErrorType ="));
  const body = declaration.slice(0, declaration.indexOf(";"));
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

const inlinedTypes = readInlinedTypes();

/**
 * 桩 `t`：记录收到的 key，按扁平字典取值，未命中返回 `defaultValue`（与 i18next 的缺键语义一致）。
 *
 * `TFunction` 的键空间重载无法由简单桩满足，故显式收窄（同
 * `packages/resources/sandbox/web/__tests__/sandbox-admin-utils.test.ts` 的做法）。
 */
function stubTranslator(dict: Map<string, string>, seen: string[]): TFunction {
  return ((key: string, options?: { defaultValue?: string }) => {
    seen.push(key);
    return dict.get(key) ?? options?.defaultValue ?? key;
  }) as unknown as TFunction;
}

describe("公开错误正文的本地化取值", () => {
  // 源码解析本身要能失败：正则失配会让下面两条断言退化为「两边都空」，静默通过。
  test("内联契约的 type 清单可被解析，且数量与协议一致", () => {
    expect(inlinedTypes.length).toBeGreaterThanOrEqual(28);
    expect(inlinedTypes).toContain("AGENT_RUNTIME.REQUEST_FAILED");
    expect(inlinedTypes).toContain("INTERNAL.UNCLASSIFIED");
  });

  // 字典键 = 前缀 + type，双向都必须对上：缺键 → 该故障的正文退回英文（或回显 key）；多键 → 死键。
  test("字典 publicError 子树的键与全部 type 逐一对应", () => {
    const expected = inlinedTypes.map((type) => `${KEY_PREFIX}${type}`).sort();
    expect(dictKeys).toEqual(expected);
    expect([...zhFlat.keys()].filter((key) => key.startsWith(KEY_PREFIX)).sort()).toEqual(expected);
  });

  // 键集一致挡不住「zh 值照抄 en」：键在、界面不报错，只是中文界面显示英文。协议表里的 zh 是
  // 当初为本地化写的译文，逐条搬入字典；若将来某条确实需要与 en 同形，在此处补豁免并写明理由，
  // 不要放宽本条。
  test("每条错误文案的 zh 都不是 en 的照抄", () => {
    const untranslated = dictKeys.filter((key) => enFlat.get(key) === zhFlat.get(key));
    expect(untranslated).toEqual([]);
    expect(dictKeys.every((key) => (enFlat.get(key) ?? "").length > 0)).toBe(true);
  });

  // 命中路径：键必须是「前缀 + type」，值必须来自字典——组件只把 `t` 传进来，键的推导是本模块的责任。
  test("已登记 type 取字典译文，且键是前缀加 type", () => {
    const seen: string[] = [];
    const error = { type: "AGENT_RUNTIME.REQUEST_FAILED", message: "The Agent request failed." };
    expect(publicErrorText(stubTranslator(zhFlat, seen), error)).toBe(zhFlat.get(`${KEY_PREFIX}${error.type}`));
    expect(seen).toEqual([`${KEY_PREFIX}AGENT_RUNTIME.REQUEST_FAILED`]);
  });

  // 兜底路径：协议新增 type 而字典未跟上时，必须退回服务端产出的英文安全摘要，而不是把 key 显示给用户。
  test("未登记 type 退回 wire 摘要，不出现 key 回显", () => {
    const seen: string[] = [];
    const error = { type: "FUTURE_DOMAIN.BRAND_NEW_FAILURE", message: "The request failed." };
    expect(publicErrorText(stubTranslator(zhFlat, seen), error)).toBe("The request failed.");
    expect(seen).toEqual([`${KEY_PREFIX}FUTURE_DOMAIN.BRAND_NEW_FAILURE`]);
  });

  // 未登记 type 且 wire 摘要为空（帧未按协议填写）时也不得回显 key：宁可留空，界面由调用方的
  // `errorText && …` 判空跳过该段。
  test("未登记 type 且摘要为空时不回显 key", () => {
    const text = publicErrorText(stubTranslator(zhFlat, []), { type: "FUTURE_DOMAIN.BRAND_NEW_FAILURE", message: "" });
    expect(text).toBe("");
  });
});
