import { afterEach, expect, test } from "bun:test";
import { stubEnvironmentRepo } from "@fenix/agent-runtime/server/testing";
import { createApiModelsRoutes } from "@fenix/model-management/server";
import {
  createStubModelManagementServerModule,
  createStubProviderFacade,
  installModelManagementModule,
  resetModelManagementModuleForTesting,
} from "@fenix/model-management/server/testing";
import type { ActorContext } from "@fenix/platform-sdk";
import { readJson, resetAllStubs, stubAuthApi, stubDb } from "@fenix/platform-sdk/testing";
import Elysia from "elysia";
import { authGuardPlugin, resetTestAuth } from "../plugins/auth";
import { errorPlugin } from "../plugins/error-handler";
import { setTestOrgContext } from "../services/org-context";

afterEach(() => {
  resetModelManagementModuleForTesting();
  resetTestAuth();
  resetAllStubs();
  setTestOrgContext(null);
});
// 真实 v1 Provider 路由经过宿主凭据解析，组织取凭据而角色取当前成员表。
test("v1 Provider query authenticates API key with current membership actor", async () => {
  resetTestAuth();
  setTestOrgContext(null);
  stubAuthApi({
    getSession: async () => null,
    verifyApiKey: async () => ({
      valid: true,
      key: { referenceId: "key-user", organizationId: "key-org", metadata: { role: "owner" } },
    }),
  });
  stubEnvironmentRepo({ getBySecret: async () => null });
  const rows = [
    [{ id: "key-user", name: "api-user", email: "user@example.test" }],
    [{ organizationId: "key-org", role: "admin" }],
  ];
  let index = 0;
  stubDb({
    select: () => ({
      from: () => ({
        where: () => {
          const result = rows[index++] ?? [];
          return { limit: async () => result, orderBy: () => ({ execute: async () => result }) };
        },
      }),
    }),
  });
  let actor: ActorContext | undefined;
  installModelManagementModule(
    createStubModelManagementServerModule({
      facade: createStubProviderFacade({
        list: async (value) => {
          actor = value;
          return { items: [], total: 0 };
        },
      }),
    }),
  );
  const app = new Elysia().use(errorPlugin).use(createApiModelsRoutes({ authGuardPlugin }));
  const response = await app.handle(
    new Request("http://localhost/api/v1/providers", { headers: { authorization: "Bearer fixture-api-key" } }),
  );
  expect(response.status).toBe(200);
  expect(await readJson(response)).toEqual({ success: true, data: { items: [], total: 0, page: 1, pageSize: 20 } });
  expect(actor).toMatchObject({
    userId: "key-user",
    activeOrganizationId: "key-org",
    memberships: [{ organizationId: "key-org", role: "admin" }],
  });
});
