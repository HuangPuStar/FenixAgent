// web/src/__tests__/permission-options.test.ts
// sessionOptionKindsToPermissionOptions 翻译函数单测：
// Session Doc 三态 kind（allow_once/allow_session/deny）→ acp-link PermissionOption[]。
// 断言重点：optionId 保留原始语义字符串（后端 CAS 原样回传）、kind 最近邻映射、
// 非数组/未知值防御。
//
// i18n 说明：翻译函数直接引用 i18next 全局实例（不经过 web/src/i18n/index.ts，
// 该模块在测试环境会被其他测试文件 mock.module 为无 default 导出）。
// bun 测试环境 i18next 未初始化资源 → t() 回退返回 key（与 SSR 行为一致），
// 故 name 断言基于 key 文案。

import { beforeAll, describe, expect, test } from "bun:test";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n/namespace";
import { sessionOptionKindsToPermissionOptions } from "@fenix/web-runtime/chat/structured-to-thread";
import i18n from "i18next";

beforeAll(async () => {
  // 全量测试时其他测试可能已 import web/src/i18n（初始化并注册完整语言资源），
  // 使 i18n.t(...) 返回真实翻译而非 key，导致断言依赖执行顺序（单独跑通过、全量跑失败）。
  // 此处显式用固定资源重新 init 覆盖（值故意等于 key），断言与全局 i18next 状态解耦。
  // 命名空间与键路径同生产代码：权限按钮词表 owner 是 `@fenix/ui-components`
  // （`chat.components.permissionPanel.*`，台账 D4 从宿主 `components` 字典归位）。
  await i18n.init({
    resources: {
      en: {
        [UI_COMPONENTS_NS]: {
          chat: {
            components: {
              permissionPanel: {
                allow: "chat.components.permissionPanel.allow",
                allowSession: "chat.components.permissionPanel.allowSession",
                deny: "chat.components.permissionPanel.deny",
              },
            },
          },
        },
      },
    },
    lng: "en",
    ns: [UI_COMPONENTS_NS],
    defaultNS: UI_COMPONENTS_NS,
    fallbackLng: false,
    interpolation: { escapeValue: false },
  });
});

describe("sessionOptionKindsToPermissionOptions", () => {
  // 三态 kind 全部翻译，optionId 保留 Session Doc 原始字符串
  test("maps the three session-doc kinds preserving optionId strings", () => {
    const options = sessionOptionKindsToPermissionOptions(["allow_once", "allow_session", "deny"]);
    expect(options).toHaveLength(3);

    expect(options[0]).toEqual({
      optionId: "allow_once",
      name: "chat.components.permissionPanel.allow",
      kind: "allow_once",
    });
    // allow_session → kind 最近邻 allow_always（驱动按钮样式），optionId 不变
    expect(options[1]).toEqual({
      optionId: "allow_session",
      name: "chat.components.permissionPanel.allowSession",
      kind: "allow_always",
    });
    // deny → kind 最近邻 reject_once，optionId 不变
    expect(options[2]).toEqual({
      optionId: "deny",
      name: "chat.components.permissionPanel.deny",
      kind: "reject_once",
    });
  });

  // 非数组输入防御：undefined/null/字符串 → 空数组
  test("returns empty array for non-array input", () => {
    expect(sessionOptionKindsToPermissionOptions(undefined)).toEqual([]);
    expect(sessionOptionKindsToPermissionOptions(null)).toEqual([]);
    expect(sessionOptionKindsToPermissionOptions("allow_once")).toEqual([]);
    expect(sessionOptionKindsToPermissionOptions({ 0: "allow_once" })).toEqual([]);
  });

  // 未知值跳过，不影响已知 kind
  test("skips unknown kinds and keeps known ones", () => {
    const options = sessionOptionKindsToPermissionOptions(["allow_once", "maybe_allow", 42, "deny"]);
    expect(options.map((o) => o.optionId)).toEqual(["allow_once", "deny"]);
  });

  // 空数组输入 → 空数组（后端兜底 ["allow_once","deny"] 已保证非空，防御性验证）
  test("returns empty array for empty input", () => {
    expect(sessionOptionKindsToPermissionOptions([])).toEqual([]);
  });
});
