import { describe, expect, test } from "bun:test";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { ORGS_NS, orgResources } from "../i18n";
import { MachineCreatedDetails } from "../pages/agent-panel/pages/agent-organizations-dialogs";
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

describe("机器创建成功指引", () => {
  // 创建后用户应能按新机器和所属组织打开连接文档，避免复制旧的初始化命令。
  test("展示完整机器 ID，并在新标签页打开对应组织的连接指引", () => {
    const machineId = "mach-created-123456789abc";
    const organizationId = "org-created-123456789abc";
    const router = createRouter({
      routeTree: createRootRoute(),
      basepath: "/ctrl",
      history: createMemoryHistory({ initialEntries: ["/ctrl/agent/organizations"] }),
    });
    const markup = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <RouterContextProvider router={router}>
          <MachineCreatedDetails machineId={machineId} organizationId={organizationId} />
        </RouterContextProvider>
      </I18nextProvider>,
    );
    expect(markup).toContain(machineId);
    expect(markup).toContain("follow the instructions to connect this machine");
    expect(markup).not.toContain("Init Command");
    expect(markup).not.toContain("acp-runtime");
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    const href = markup.match(/href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    expect(href).toBeDefined();
    const url = new URL(href!, "https://platform.example");
    expect(url.pathname).toBe("/ctrl/agent/machine/connection-guide");
    expect(url.searchParams.get("machineId")).toBe(machineId);
    expect(url.searchParams.get("organizationId")).toBe(organizationId);
  });
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
