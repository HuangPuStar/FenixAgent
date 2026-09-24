// web/__tests__/cron-text-stub.ts
//
// `describeCron` 的文案替身：直接读包内 **zh 字典** 的模板做 `{{var}}` 插值。
//
// 为什么不用 `(key) => key` 的回显替身：模板与插值参数都进了字典之后（2026-09-23 第 19 轮），
// 回显替身只能验证「键名拼对了」，验证不到真实文案——而 `describeCron` 的边界（越界星期索引、
// 通配分钟、指定月分支的时段与时刻之间没有空格）恰好都体现在模板拼接的结果上。
// 缺键直接抛错，顺带把「源码取的键与字典不同步」变成红用例。

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ZH = JSON.parse(readFileSync(join(import.meta.dir, "../i18n/locales/zh/tasks-v2.json"), "utf8")) as Record<
  string,
  unknown
>;
const EN = JSON.parse(readFileSync(join(import.meta.dir, "../i18n/locales/en/tasks-v2.json"), "utf8")) as Record<
  string,
  unknown
>;

/** 把嵌套字典摊平成点号路径（与 `task-i18n.test.ts` 同口径），供「键是否在字典里」的断言用。 */
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

/** zh / en 字典的扁平视图（键 → 文案）。 */
export const zhFlat = flatten(ZH);
export const enFlat = flatten(EN);

/** 按点号路径取扁平化后的字典值；取不到（或不是字符串）视为缺键并抛错。 */
function lookup(key: string): string {
  let node: unknown = ZH;
  for (const segment of key.split(".")) {
    if (node === null || typeof node !== "object") break;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== "string") throw new Error(`字典缺少键：${key}`);
  return node;
}

/** 插值口径与 i18next 一致：`{{var}}` 替换，单花括号是字面量（本字典不使用）。 */
export function cronText(key: string, options?: Record<string, unknown>): string {
  let text = lookup(key);
  for (const [name, value] of Object.entries(options ?? {})) {
    text = text.replaceAll(`{{${name}}}`, String(value));
  }
  return text;
}
