import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { createAgentConfigAgentSitesCompatRoutes, createAgentConfigAgentSitesProxyRoutes } from "../server/assembly";
import type { SitePublishTarget } from "../server/services/agent-site-publish-cache";
import { initializeAgentConfigModuleConfig } from "../server/testing";
import { installAgentModuleStub, resetAgentModuleStub } from "./fixtures";

const APP_ID = "app-037dc43a";
const SITE_ORG = "site-org";
const PERSONAL_ORG = "personal-org";
const PAGE = "<html><body>站点已加载</body></html>";

/** 模拟宿主按成员关系解析组织：组织提示不是授权，非成员会回退到已有组织。 */
function createHost(
  options: { userId?: string; memberships?: readonly string[]; credentialOrganizationId?: string } = {},
) {
  const authRequests: Request[] = [];
  const memberships = options.memberships ?? [PERSONAL_ORG, SITE_ORG];
  const host: ServerRouteHost = {
    authGuardPlugin: undefined,
    systemApiGuardPlugin: undefined,
    environmentLookup: undefined,
    userAgentPreferences: undefined,
    userModelPreferences: undefined,
    resolveSecretReference: undefined,
    verifyEnvironmentOwnership: undefined,
    logError: undefined,
    authenticateRequest: async (request: Request) => {
      authRequests.push(request);
      if (!options.userId) return null;
      const requested = request.headers.get("x-active-org-id");
      const organizationId =
        options.credentialOrganizationId ?? memberships.find((id) => id === requested) ?? memberships[0];
      return { authContext: { userId: options.userId, organizationId } };
    },
  };
  return { host, authRequests };
}

const entryPoints = [
  { name: "部署入口", create: createAgentConfigAgentSitesProxyRoutes, prefix: `/web/site/deploy/${APP_ID}` },
  { name: "绝对路径兜底", create: createAgentConfigAgentSitesCompatRoutes, prefix: `/${APP_ID}` },
];

describe("AOS-BUG-001 站点发布访问", () => {
  const originalFetch = globalThis.fetch;
  let target: SitePublishTarget;
  let forwarded: { url: string; init?: RequestInit }[];

  beforeEach(() => {
    initializeAgentConfigModuleConfig({
      agentSitesBaseUrl: "http://agent-sites.test",
      agentSitesMasterKey: crypto.randomUUID(),
    });
    resetAgentModuleStub();
    target = { visibility: "org", organizationId: SITE_ORG, userId: "creator" };
    forwarded = [];
    installAgentModuleStub({ siteFacade: { findPublishTarget: async () => target } });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      forwarded.push({ url: String(input), init });
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAgentModuleStub();
  });

  for (const entry of entryPoints) {
    describe(entry.name, () => {
      // 新窗口和静态资源不带组织头，不能把成员的个人组织回退误判为无权访问。
      test("org 同组织普通成员无需组织提示即可加载页面与子资源", async () => {
        const { host, authRequests } = createHost({ userId: "member" });
        const route = entry.create(host);
        for (const suffix of ["/", "/assets/main.js"]) {
          const response = await route.handle(new Request(`http://localhost${entry.prefix}${suffix}`));
          expect(response.status).toBe(200);
          expect(await response.text()).toBe(PAGE);
          expect(response.headers.get("location")).toBeNull();
        }
        expect(authRequests.map((request) => request.headers.get("x-active-org-id"))).toEqual([SITE_ORG, SITE_ORG]);
        expect(forwarded).toHaveLength(2);
      });

      // 站点组织由服务端发布目标确定，不能依赖浏览器当前选中的另一个合法组织。
      test("org 成员携带其他组织上下文仍可访问，原请求不被改写", async () => {
        const { host } = createHost({ userId: "member" });
        const request = new Request(`http://localhost${entry.prefix}/`, {
          headers: { "x-active-org-id": PERSONAL_ORG },
        });
        const response = await entry.create(host).handle(request);
        expect(response.status).toBe(200);
        expect(request.headers.get("x-active-org-id")).toBe(PERSONAL_ORG);
        expect(new Headers(forwarded[0]?.init?.headers).get("x-active-org-id")).toBe(PERSONAL_ORG);
      });

      // 组织提示必须经成员校验，外部用户即使伪造站点组织也不能触发上游访问。
      test("org 组织外用户被拒绝，包括伪造组织提示", async () => {
        const { host } = createHost({ userId: "outsider", memberships: [PERSONAL_ORG] });
        const route = entry.create(host);
        for (const headers of [undefined, { "x-active-org-id": SITE_ORG }]) {
          const response = await route.handle(new Request(`http://localhost${entry.prefix}/`, { headers }));
          expect(response.status).toBe(302);
          expect(response.headers.get("location")).toBe("/ctrl/no-access");
        }
        expect(forwarded).toHaveLength(0);
      });

      // 凭据组织由认证端口恢复，不能因站点组织提示跨越 API Key 的组织边界。
      test("org 不扩大绑定到其他组织的凭据权限", async () => {
        const { host } = createHost({ userId: "member", credentialOrganizationId: PERSONAL_ORG });
        const response = await entry.create(host).handle(new Request(`http://localhost${entry.prefix}/`));
        expect(response.headers.get("location")).toBe("/ctrl/no-access");
        expect(forwarded).toHaveLength(0);
      });

      // private 的发布规则仍仅允许创建者，组织成员身份不赋予私有站点访问权。
      test("private 拒绝同组织其他成员和组织外用户", async () => {
        target = { ...target, visibility: "private" };
        for (const memberships of [[SITE_ORG], [PERSONAL_ORG]]) {
          const { host } = createHost({ userId: "other-user", memberships });
          const response = await entry.create(host).handle(new Request(`http://localhost${entry.prefix}/`));
          expect(response.status).toBe(302);
          expect(response.headers.get("location")).toBe("/ctrl/no-access");
        }
        expect(forwarded).toHaveLength(0);
      });

      // 创建者的 org 与 private 站点均应保留可访问行为。
      test("创建者仍可加载 org 和 private 站点", async () => {
        const { host } = createHost({ userId: "creator", memberships: [SITE_ORG] });
        const route = entry.create(host);
        for (const visibility of ["org", "private"] as const) {
          target = { ...target, visibility };
          const response = await route.handle(new Request(`http://localhost${entry.prefix}/`));
          expect(response.status).toBe(200);
          expect(await response.text()).toBe(PAGE);
        }
        expect(forwarded).toHaveLength(2);
      });

      // 非公开站点仍要求登录，不能因服务端注入组织提示而成为匿名访问。
      test("未登录访问非公开站点仍跳转登录", async () => {
        const { host } = createHost();
        const route = entry.create(host);
        for (const visibility of ["org", "private", "authenticated"] as const) {
          target = { ...target, visibility };
          const response = await route.handle(new Request(`http://localhost${entry.prefix}/`));
          expect(response.status).toBe(302);
          expect(response.headers.get("location")).toBe(
            `/ctrl/login?redirect=${encodeURIComponent(`${entry.prefix}/`)}`,
          );
        }
        expect(forwarded).toHaveLength(0);
      });

      // public 与 authenticated 的发布范围不因 org 修复而收窄。
      test("public 匿名访问与 authenticated 已登录跨组织访问保持正常", async () => {
        const anonymous = createHost();
        target = { ...target, visibility: "public" };
        expect(
          (await entry.create(anonymous.host).handle(new Request(`http://localhost${entry.prefix}/`))).status,
        ).toBe(200);
        expect(anonymous.authRequests).toHaveLength(0);
        target = { ...target, visibility: "authenticated" };
        const { host } = createHost({ userId: "outsider", memberships: [PERSONAL_ORG] });
        expect((await entry.create(host).handle(new Request(`http://localhost${entry.prefix}/`))).status).toBe(200);
      });

      // 认证只读取独立请求的头信息，不能消耗原始 POST 流或污染上游查询参数。
      test("org 认证保留 POST 请求体与原始查询", async () => {
        const { host } = createHost({ userId: "member" });
        const response = await entry.create(host).handle(
          new Request(`http://localhost${entry.prefix}/api/data?q=1`, {
            method: "POST",
            body: "site-payload",
          }),
        );
        expect(response.status).toBe(200);
        expect(forwarded[0]?.url).toBe(`http://agent-sites.test/${APP_ID}/api/data?q=1`);
        expect(forwarded[0]?.init?.method).toBe("POST");
        expect(await new Response(forwarded[0]?.init?.body).text()).toBe("site-payload");
        expect(new Headers(forwarded[0]?.init?.headers).has("x-active-org-id")).toBe(false);
      });
    });
  }
});
