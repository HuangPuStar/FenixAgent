import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { ORGS_NS, orgResources } from "../i18n";
import { OrganizationIdCopy } from "../pages/agent-panel/pages/agent-organizations-workspace";

/**
 * 渲染用的真实 i18next 实例：挂本包 en 字典。
 *
 * 不再 import 宿主 `apps/web/src/i18n` 单例（那是 `@/src/i18n` 别名越界，§1.6 T4 已归零）：
 * 组件现在按 `NS.ORGS` 取字典，测试只要提供同名命名空间即可，宿主单例与宿主自有命名空间
 * 都不必出现在本包用例里。`resources` 必须带语言维度 `{ en: { [NS]: 字典 } }`，
 * 少一层时 `t()` 会静默回显 key。
 */
const i18n = createInstance();
void i18n.init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: ORGS_NS,
  initAsync: false,
  resources: { en: { [ORGS_NS]: orgResources.en } },
});

describe("组织详情 ID 展示", () => {
  // 组织 ID 是用户需要复制和核对的标识，详情头部应展示完整值而不是固定截取前 12 位。
  test("完整渲染组织 ID", () => {
    const organizationId = "d1b00bf2-00c0-4a31-a8cf-123456789abc";
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(OrganizationIdCopy, { id: organizationId, onCopy: () => {} }),
      ),
    );

    expect(markup).toContain(organizationId);
    expect(markup).not.toContain(`${organizationId.slice(0, 12)}</code>`);
  });
});
