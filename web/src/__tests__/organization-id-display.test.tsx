import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "../i18n";
import { OrganizationIdCopy } from "../pages/agent-panel/pages/agent-organizations-workspace";

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
