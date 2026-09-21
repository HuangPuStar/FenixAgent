// 公开错误的「协议登记表 ↔ 界面字典」一致性契约。
//
// 为什么这份测试在宿主：`@fenix/chat-channel` 的 `PUBLIC_ERROR_MESSAGES` 是 wire 与日志的规范登记表
// （`createPublicError` 恒取 `.en`，`isPublicError` 以它校验不可信帧），而界面正文自 §1.6 T9d 起按
// 稳定的 `error.type` 从 `@fenix/ui-components` 的 `uiComponents` 字典取译文——同一句话因此各存一份。
// 宿主的 `apps/web/src/i18n/index.ts` 是唯一同时依赖两者的地方（包之间没有这条依赖边），故契约测试
// 落在这里。两处一旦漂移，同一种故障在日志、wire 响应与界面里会显示不同文案，且没有任何运行期报错。
//
// 键的存在性（字典是否覆盖全部 type、是否有多余死键、zh 是否照抄 en）由包内
// `packages/ui-components/web/__tests__/public-error-text.test.ts` 穷举断言；本文件只钉「逐字相等」。

import { describe, expect, test } from "bun:test";
import { PUBLIC_ERROR_MESSAGES, PUBLIC_ERROR_TYPES } from "@fenix/chat-channel";
import { uiComponentsResources } from "@fenix/ui-components/i18n";

/** 把嵌套字典摊平成点号路径（与各 i18n 测试同口径）。 */
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

const KEY_PREFIX = "chat.components.publicError.";
const enFlat = flatten(uiComponentsResources.en as Record<string, unknown>);
const zhFlat = flatten(uiComponentsResources.zh as Record<string, unknown>);

describe("公开错误文案的协议表与字典一致性", () => {
  // 逐字相等是唯一的对齐标准：字典值一旦被改写（哪怕只是标点），同一故障在日志与界面就会说两句不同的话。
  test("字典的 en / zh 文案与协议登记表逐字相等", () => {
    const mismatched = PUBLIC_ERROR_TYPES.flatMap((type) => {
      const key = `${KEY_PREFIX}${type}`;
      const registry = PUBLIC_ERROR_MESSAGES[type];
      return enFlat.get(key) === registry.en && zhFlat.get(key) === registry.zh
        ? []
        : [
            `${type} (registry: ${JSON.stringify(registry)} / dict: ${JSON.stringify([enFlat.get(key), zhFlat.get(key)])})`,
          ];
    });
    expect(mismatched).toEqual([]);
  });

  // 反向：字典里不得出现协议表没有的 type（协议删 type 而字典留下的就是死键）。
  test("字典 publicError 子树不含协议表之外的 type", () => {
    const known = new Set(PUBLIC_ERROR_TYPES.map((type) => `${KEY_PREFIX}${type}`));
    expect([...enFlat.keys()].filter((key) => key.startsWith(KEY_PREFIX) && !known.has(key))).toEqual([]);
  });
});
