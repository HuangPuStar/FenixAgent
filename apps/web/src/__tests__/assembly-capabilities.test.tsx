import { expect, test } from "bun:test";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { generatedWebContributionEntries } from "../../../generated/web-contributions";
import fixture from "../../../server/src/__tests__/fixtures/assembly-without-workflow.json";
import zh from "../i18n/locales/zh/common.json";
import type { AssemblyCapabilitiesState } from "../shell/AssemblyCapabilitiesProvider";
import { AssemblyRouteState } from "../shell/AssemblyRouteGate";
import { assemblyHiddenTabs, enabledWebIds, routeWebId } from "../shell/assembly-capabilities";
import { ASSEMBLED_NAV_GROUPS, filterNavGroups } from "../shell/shell-navigation";

const i18n = createInstance();
await i18n.init({ lng: "zh", resources: { zh: { common: zh } }, defaultNS: "common", initAsync: false });

function renderPath(path: string, state: Partial<AssemblyCapabilitiesState> = {}) {
  let mounted = false;
  function Page() {
    mounted = true;
    return <p>业务页面</p>;
  }
  const html = renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <AssemblyRouteState
        moduleId={routeWebId(path)}
        state={{ enabled: enabledWebIds(fixture.web), loading: false, failed: false, retry: () => {}, ...state }}
      >
        <Page />
      </AssemblyRouteState>
    </I18nextProvider>,
  );
  return { html, mounted };
}

// 同一份服务端 fixture 在浏览器收窄 workflow，而 hiddenTabs 仍按导航项 ID 叠加。
test("装配关闭 workflow 与隐藏偏好叠加，其他入口和顺序不变", () => {
  const groups = filterNavGroups(
    [...ASSEMBLED_NAV_GROUPS],
    ["skills", ...assemblyHiddenTabs(enabledWebIds(fixture.web))],
  );
  const ids = groups.flatMap((group) => group.items.map((item) => item.id));
  expect(ids).not.toContain("workflow");
  expect(ids).not.toContain("skills");
  expect(ids).toContain("agents");
  expect(ids).toEqual(
    ASSEMBLED_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id)).filter(
      (id) => !["workflow", "skills"].includes(id),
    ),
  );
});

// 直达入口、带 basepath 的 URL 与画布深链都不能挂载业务子树。
test("workflow 关闭后直达及子路径展示未启用，不触发业务页面", () => {
  for (const path of ["/agent/workflow", "/ctrl/agent/workflow", "/agent/workflow/123/edit"]) {
    const { html, mounted } = renderPath(path);
    expect(html).toContain("模块 workflow 未启用");
    expect(html).not.toContain("404");
    expect(mounted).toBe(false);
  }
});

// 运行期清单不能把未编译进 bundle 的贡献变成可用能力。
test("bundle 是上界，空清单关闭全部而获取失败保留全部", () => {
  expect(enabledWebIds(["not-in-bundle"]).size).toBe(0);
  expect(enabledWebIds([]).size).toBe(0);
  expect([...enabledWebIds(undefined)]).toEqual(generatedWebContributionEntries.map((entry) => entry.id));
  expect(assemblyHiddenTabs(enabledWebIds(undefined))).toEqual([]);
});

// 正常启用时共享边界不替换页面，路径段前缀也不得误伤名称相似的其他入口。
test("启用回归与精确路径归属", () => {
  expect(renderPath("/agent/workflow", { enabled: enabledWebIds(undefined) }).mounted).toBe(true);
  expect(routeWebId("/agent/workflow-other")).toBeUndefined();
  expect(routeWebId("/agent/model-gateway-usage/provider")).toBe("model-management");
  for (const entry of generatedWebContributionEntries) {
    for (const item of entry.contribution.navigation ?? []) {
      expect(routeWebId(`/agent/${item.id}/detail`)).toBe(entry.id);
      expect(renderPath(`/agent/${item.id}`, { enabled: new Set() }).mounted).toBe(false);
    }
  }
});

// 加载时阻止页面提前发请求，失败则明确提示并放行业务，不留下白屏。
test("loading 与 fail-open error 状态有可访问反馈", () => {
  const loading = renderPath("/agent/workflow", { loading: true });
  expect(loading.html).toContain("正在读取模块启用状态");
  expect(loading.mounted).toBe(false);
  const failed = renderPath("/agent/workflow", { failed: true, enabled: enabledWebIds(undefined) });
  expect(failed.html).toContain("模块清单读取失败");
  expect(failed.html).toContain("重试");
  expect(failed.mounted).toBe(true);
});
