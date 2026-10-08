import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActorContext, ResourceAction } from "@fenix/platform-sdk";
import { stubDb } from "@fenix/platform-sdk/testing";
import { agentSiteAppResource } from "../server/access/agent-site-app-resource";
import { AgentSiteAppFacade } from "../server/facades/agent-site-app-facade";
import type { AgentSiteAppRow, ScopedAgentSiteAppRow } from "../server/repositories/agent-site-app";
import type { AgentSiteAppService } from "../server/services/agent-site-app-service";
import { invalidatePublishTarget } from "../server/services/agent-site-publish-cache";
import { initializeAgentConfigModuleConfig } from "../server/testing";
import {
  createFakeAccessControl,
  createRecordingScopeStore,
  installAgentModuleStub,
  resetAgentModuleStub,
  scopedAgent,
  testActor,
  testListConstraint,
} from "./fixtures";

/**
 * 站点 App Facade 用例：站点专属规则与编排的验收面。
 *
 * 覆盖三件事：
 * 1. **主体解析**：无法定位组织资源的主体（未认证 / 无 active organization / 不在成员关系里）一律
 *    `no_organization`，协议层映射为 401；
 * 2. **站点专属规则**：发布范围的读口径（由领域服务的业务条件承担）、写权限（归属者本人 或
 *    组织 owner/admin）、创建（任意组织成员，发布范围来自请求）；
 * 3. **编排**：远端平台调用顺序、部署元数据回写、发布面缓存与失效、绑定编排的组织校验。
 *
 * 授权规则本身（角色 → 动作集合）由 `@fenix/access-control` 的用例覆盖，这里只验证 Facade 把哪一份
 * 事实交给授权模块、以及它自己叠加的那条归属者规则。
 */

const APP_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-19T00:00:00.000Z");

/** 站点行替身；带平台解析出的归属范围（受控读取的产出形状）。 */
function siteRow(overrides: Partial<AgentSiteAppRow> = {}): ScopedAgentSiteAppRow {
  return {
    id: APP_ID,
    organizationId: "org-1",
    userId: "user-1",
    remoteAppId: "app-demo",
    name: "demo-app",
    description: null,
    platformToken: "platform-token",
    platformTokenId: "token-old",
    visibility: "private",
    appType: "pocketbase",
    entryFile: null,
    activeSlot: null,
    deployedAt: null,
    createdByAgentConfigId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
    scope: { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" },
  };
}

/**
 * 记录调用的领域服务替身；默认无命中（用例按需给出返回值）。
 *
 * 记录发生在**包装后**的方法上：用例替换某个方法时不写日志会让"Facade 到底调了哪份事实"的断言静默
 * 失真，因此这里先合并默认实现与覆盖，再统一包一层记录。
 */
function createFakeService(overrides: Partial<AgentSiteAppService> = {}) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown) => {
    calls[name] = [...(calls[name] ?? []), args];
  };
  const base: AgentSiteAppService = {
    listVisible: async () => [],
    findVisible: async () => undefined,
    findInOrganization: async () => undefined,
    listVisibleByIds: async () => [],
    findPublishTargetByRemoteAppId: async () => undefined,
    create: async () => siteRow(),
    update: async () => siteRow(),
    remove: async () => true,
    ...overrides,
  };
  const service = Object.fromEntries(
    Object.entries(base).map(([name, implementation]) => [
      name,
      (input: unknown, ...rest: unknown[]) => {
        record(name, rest.length === 0 ? input : [input, ...rest]);
        return (implementation as (...args: unknown[]) => unknown)(input, ...rest);
      },
    ]),
  ) as unknown as AgentSiteAppService;
  return { service, calls };
}

/** 安装站点 Facade；`actions` 是授权模块对该主体给出的动作集合。 */
function installFacade(options: {
  readonly service: AgentSiteAppService;
  readonly actions?: readonly ResourceAction[];
}) {
  const scopeStore = createRecordingScopeStore().store;
  const actions = options.actions ?? ["read", "create", "update", "delete"];
  return new AgentSiteAppFacade(options.service, {
    accessControl: createFakeAccessControl({
      resolveAccess: async () => ({ actions }),
      createListConstraint: async ({ action }) => testListConstraint(action),
    }),
    resource: agentSiteAppResource.definition,
    scopeStore,
  });
}

let originalFetch: typeof fetch;
let requests: Array<{ url: string; init: RequestInit | undefined }>;

function remoteResponse(url: string) {
  if (url.endsWith("/api/apps") && requests.at(-1)?.init?.method === "POST") {
    return { data: { id: "app-created", name: "created-app", type: "custom" } };
  }
  if (url.endsWith("/api/tokens") && requests.at(-1)?.init?.method === "POST") {
    return { data: { token: "token-new", token_id: "token-new-id" } };
  }
  if (url.includes("/deploy")) {
    return { data: { files: 2, total_bytes: 64, entry_file: "main.ts", slot: "b" } };
  }
  if (url.includes("/bundle")) return { data: { files: 2 } };
  if (url.includes("/files/")) return { data: { path: "index.html", bytes: 12 } };
  return { data: { proxied: true } };
}

beforeEach(() => {
  // 站点链路配置由宿主下发；未配置时 Facade 在发请求前就会失败，用例必须给出同一份配置。
  initializeAgentConfigModuleConfig({
    agentSitesBaseUrl: "https://agent-sites.test",
    agentSitesMasterKey: "test-master-key",
  });
  requests = [];
  originalFetch = globalThis.fetch;
  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: input.toString(), init });
    return new Response(JSON.stringify(remoteResponse(input.toString())), {
      headers: { "content-type": "application/json" },
    });
  };
  globalThis.fetch = Object.assign(fetchStub, { preconnect: originalFetch.preconnect });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetAgentModuleStub();
  invalidatePublishTarget("app-demo");
});

describe("站点 Facade — 主体解析", () => {
  // 未认证主体（store.actor 为 null）无法定位组织资源，必须抛 no_organization 而不是"看见零行"。
  test("无主体时抛 no_organization", async () => {
    const { service } = createFakeService();
    await expect(installFacade({ service }).list(null)).rejects.toThrow("no_organization");
  });

  // 已认证但无 active organization（API Key 未绑定组织）同样无法定位组织资源。
  test("无 active organization 时抛 no_organization", async () => {
    const { service } = createFakeService();
    const actor = testActor({ activeOrganizationId: undefined, memberships: [] });
    await expect(installFacade({ service }).list(actor)).rejects.toThrow("no_organization");
  });

  // 当前组织不在成员关系里（成员关系已被移除）时保守拒绝，不退化成"组织内公开资源可见"。
  test("当前组织不在成员关系里时抛 no_organization", async () => {
    const { service } = createFakeService();
    const actor = testActor({ memberships: [{ organizationId: "org-other", role: "owner" }] });
    await expect(installFacade({ service }).list(actor)).rejects.toThrow("no_organization");
  });
});

describe("站点 Facade — 读范围", () => {
  // 列表把平台条件与当前用户交给领域服务：授权谓词与发布范围的业务条件必须在同一条 SQL 里。
  test("列表把授权条件与用户标识交给领域服务", async () => {
    const { service, calls } = createFakeService({
      listVisible: async () => [siteRow(), siteRow({ id: "app-2", createdByAgentConfigId: "agent-1" })],
    });
    stubDb({
      select: () => ({ from: () => ({ where: () => Promise.resolve([{ id: "agent-1", name: "开发智能体" }]) }) }),
    });

    const items = await installFacade({ service }).list(testActor());

    expect(calls.listVisible?.[0]).toMatchObject({ userId: "user-1" });
    expect(items[0]?.createdByAgentConfigName).toBeNull();
    expect(items[1]?.createdByAgentConfigName).toBe("开发智能体");
  });

  // 详情不可见（跨组织或他人的 private 站点）一律 site_not_found：不区分"不存在"与"不可见"，不泄漏存在性。
  test("详情未命中抛 site_not_found", async () => {
    const { service } = createFakeService();
    await expect(installFacade({ service }).getById(testActor(), APP_ID)).rejects.toThrow("site_not_found");
  });

  // 详情命中时按远端 app id 也能取回同一行（聊天卡片与站点识别链路依赖这条路径）。
  test("按远端 app id 取详情", async () => {
    const { service, calls } = createFakeService({ findVisible: async () => siteRow({ remoteAppId: "app-remote" }) });
    const item = await installFacade({ service }).getByRemoteAppId(testActor(), "app-remote");

    expect(item.remoteAppId).toBe("app-remote");
    expect(calls.findVisible?.[0]).toMatchObject({ remoteAppId: "app-remote", userId: "user-1" });
  });
});

describe("站点 Facade — 写权限", () => {
  // 归属者本人（组织内的普通成员）可修改自己的站点：授权模块只给出 read，本行归属仍应放行。
  test("归属者本人可更新自己的站点", async () => {
    const { service } = createFakeService({ findInOrganization: async () => siteRow() });
    const actor = testActor({ userId: "user-1", memberships: [{ organizationId: "org-1", role: "member" }] });
    const facade = installFacade({ service, actions: ["read"] });

    await expect(facade.update(actor, APP_ID, { name: "new-name" })).resolves.toMatchObject({ id: APP_ID });
  });

  // 普通成员既不是归属者、授权模块也只给 read 时不得修改他人站点（403 语义）。
  test("普通成员不能修改他人站点", async () => {
    const { service } = createFakeService({ findInOrganization: async () => siteRow({ userId: "user-2" }) });
    const actor = testActor({ userId: "user-1", memberships: [{ organizationId: "org-1", role: "member" }] });
    const facade = installFacade({ service, actions: ["read"] });

    await expect(facade.update(actor, APP_ID, { name: "new-name" })).rejects.toThrow("forbidden");
  });

  // 组织 owner / admin 由授权模块给出全量动作，因此可以管理他人的站点（含 private）：既有契约里
  // 管理员可删除他人的 private 站点。
  test("组织管理员可删除他人 private 站点", async () => {
    const { service } = createFakeService({ findInOrganization: async () => siteRow({ userId: "user-2" }) });
    const facade = installFacade({ service, actions: ["read", "create", "update", "delete"] });

    await facade.remove(testActor(), APP_ID);

    expect(requests.at(-1)?.url).toContain("/api/apps/app-demo");
    expect(requests.at(-1)?.init?.method).toBe("DELETE");
  });

  // 不可见的站点在写路径上按 404 处理：跨组织行取不到，不能因为"知道 ID"就改写。
  test("写路径未命中抛 site_not_found 且不触碰远端", async () => {
    const { service } = createFakeService();
    await expect(installFacade({ service }).remove(testActor(), APP_ID)).rejects.toThrow("site_not_found");
    expect(requests).toHaveLength(0);
  });

  // 更新发布范围后必须让代理缓存失效：否则旧范围会继续生效到 TTL 结束。
  test("更新发布范围使发布面缓存失效", async () => {
    const { service, calls } = createFakeService({
      findInOrganization: async () => siteRow(),
      findPublishTargetByRemoteAppId: async () => siteRow({ visibility: "org" }),
    });
    const facade = installFacade({ service });

    expect(await facade.findPublishTarget("app-demo")).toMatchObject({ visibility: "org" });
    await facade.update(testActor(), APP_ID, { visibility: "org" });
    await facade.findPublishTarget("app-demo");

    // 缓存失效后必须重新回库一次（共两次）。
    expect(calls.findPublishTargetByRemoteAppId).toHaveLength(2);
  });
});

describe("站点 Facade — 创建与生命周期编排", () => {
  // 创建串起远端 app、token 与本地行，并把归属与请求给出的发布范围一起写入。
  test("创建串联远端 app 与 token 并写入归属", async () => {
    const { service, calls } = createFakeService();
    const item = await installFacade({ service }).create(testActor(), {
      name: "created-app",
      type: "custom",
      visibility: "public",
      agentConfigId: "agent-1",
    });

    expect(item.id).toBe(APP_ID);
    expect(calls.create?.[0]).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-created",
      name: "created-app",
      platformToken: "token-new",
      platformTokenId: "token-new-id",
      visibility: "public",
      appType: "custom",
      createdByAgentConfigId: "agent-1",
    });
  });

  // 旧 token 吊销失败不能挡住重签：记录后继续申请新 token 并更新本地行。
  test("重签 token 在吊销失败后继续", async () => {
    const { service, calls } = createFakeService({ findInOrganization: async () => siteRow() });
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input.toString();
        requests.push({ url, init });
        if (url.includes("token-old")) return new Response(JSON.stringify({ message: "gone" }), { status: 404 });
        return new Response(JSON.stringify(remoteResponse(url)), { headers: { "content-type": "application/json" } });
      },
      { preconnect: originalFetch.preconnect },
    );

    await installFacade({ service }).rotateToken(testActor(), APP_ID);

    expect(calls.update?.[0]).toMatchObject([APP_ID, { platformToken: "token-new", platformTokenId: "token-new-id" }]);
  });

  // 单文件上传把路径与二进制体转交远端，并把上游数据原样回给协议层。
  test("上传单个文件返回上游数据", async () => {
    const { service } = createFakeService({ findInOrganization: async () => siteRow() });
    const data = await installFacade({ service }).uploadFile(testActor(), APP_ID, "index.html", null);

    expect(data).toEqual({ path: "index.html", bytes: 12 });
    expect(requests[0]?.url).toContain("/files/index.html");
  });

  // PocketBase 类型没有可部署的用户代码：必须在调用远端前以 400 语义拒绝。
  test("非 custom 类型拒绝部署", async () => {
    const { service } = createFakeService({ findInOrganization: async () => siteRow() });
    await expect(installFacade({ service }).deploy(testActor(), APP_ID, null)).rejects.toThrow("not_custom");
    expect(requests).toHaveLength(0);
  });

  // custom 部署把平台返回的入口文件与槽位写回本地，并回传秒级时间所需的时刻。
  test("custom 部署写回部署元数据", async () => {
    const { service, calls } = createFakeService({ findInOrganization: async () => siteRow({ appType: "custom" }) });
    const result = await installFacade({ service }).deploy(testActor(), APP_ID, null);

    expect(calls.update?.[0]).toMatchObject([APP_ID, { entryFile: "main.ts", activeSlot: "b" }]);
    expect(result).toMatchObject({ files: 2, totalBytes: 64, entryFile: "main.ts", slot: "b" });
  });

  // custom 类型没有 PocketBase：PB 透传必须本包先拒绝，避免上游 404 被误读成"站点不存在"。
  test("custom 类型拒绝 PocketBase 透传", async () => {
    const { service } = createFakeService({ findInOrganization: async () => siteRow({ appType: "custom" }) });
    await expect(installFacade({ service }).getPocketBaseProxyTarget(testActor(), APP_ID)).rejects.toThrow(
      "pocketbase_unsupported",
    );
  });

  // PocketBase 透传注入 platform token；token 不进入任何响应体。
  test("PocketBase 透传返回远端 app 与 token", async () => {
    const { service } = createFakeService({ findInOrganization: async () => siteRow() });
    const target = await installFacade({ service }).getPocketBaseProxyTarget(testActor(), APP_ID);

    expect(target).toEqual({ remoteAppId: "app-demo", platformToken: "platform-token" });
  });
});

describe("站点 Facade — 绑定编排与发布面", () => {
  // 绑定展开按绑定顺序返回可见站点；空绑定不查库。
  test("绑定展开按绑定顺序返回可见站点", async () => {
    const { service, calls } = createFakeService({
      listVisibleByIds: async () => [siteRow({ id: "a" }), siteRow({ id: "b" })],
    });
    // 第一次 select 读绑定表（顺序 [a, b]），第二次读创建者名称。
    let selectCount = 0;
    stubDb({
      select: () => {
        selectCount += 1;
        return {
          from: () => ({
            where: () => Promise.resolve(selectCount === 1 ? [{ siteAppId: "a" }, { siteAppId: "b" }] : []),
          }),
        };
      },
    });

    const items = await installFacade({ service }).listBoundApps(testActor(), "agent-1");

    expect(items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(calls.listVisibleByIds?.[0]).toMatchObject({ userId: "user-1", ids: ["a", "b"] });
  });

  // 绑定前先确认 Agent 配置属于当前组织，否则按 404 语义拒绝。
  test("绑定不存在 agent config 抛 agent_not_found", async () => {
    const { service } = createFakeService();
    installAgentModuleStub({ service: { findRowUnscoped: async () => undefined } });

    await expect(installFacade({ service }).bind(testActor(), "agent-1", APP_ID)).rejects.toThrow("agent_not_found");
  });

  // remoteAppId 形式的站点标识必须解析为本地 UUID 后再写绑定表。
  test("按远端 ID 绑定写入本地 UUID", async () => {
    const { service } = createFakeService({ findInOrganization: async () => siteRow() });
    installAgentModuleStub({ service: { findRowUnscoped: async () => scopedAgent({ id: "agent-1" }) } });
    const bound: Array<Record<string, unknown>> = [];
    stubDb({
      insert: () => ({
        values: (values: Record<string, unknown>) => ({ onConflictDoNothing: async () => bound.push(values) }),
      }),
    });

    await installFacade({ service }).bind(testActor(), "agent-1", "app-demo");

    expect(bound).toEqual([{ agentConfigId: "agent-1", siteAppId: APP_ID }]);
  });

  // 发布面定位按远端 app id 命中并缓存：第二次读取不再回库。
  test("发布面定位命中缓存", async () => {
    const { service, calls } = createFakeService({
      findPublishTargetByRemoteAppId: async () => siteRow({ visibility: "public" }),
    });
    const facade = installFacade({ service });

    expect(await facade.findPublishTarget("app-demo")).toMatchObject({ visibility: "public", userId: "user-1" });
    expect(await facade.findPublishTarget("app-demo")).toMatchObject({ visibility: "public" });
    expect(calls.findPublishTargetByRemoteAppId).toHaveLength(1);
  });

  // 未登记的远端 app 返回 null：代理据此放行给后续路由，不伪造一个发布目标。
  test("发布面未命中返回 null", async () => {
    const { service } = createFakeService();
    expect(await installFacade({ service }).findPublishTarget("app-missing")).toBeNull();
  });
});

/** 主体替身（组织内 owner）；导出给下方类型断言使用，避免测试文件里出现未使用告警。 */
export type { ActorContext };
