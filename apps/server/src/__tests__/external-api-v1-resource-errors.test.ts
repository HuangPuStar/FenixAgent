import { afterEach, expect, test } from "bun:test";
import { createApiAgentsRoutes } from "@fenix/agent-config/server";
import {
  createStubAgentAssociations,
  createStubAgentConfigFacade,
  createStubAgentConfigServerModule,
  installAgentConfigModule,
  resetAgentConfigModuleForTesting,
} from "@fenix/agent-config/server/testing";
import { initializeTestApplicationInfrastructure, readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import { InvalidKnowledgeBindingError } from "@fenix/resource-knowledge/server";
import {
  type AgentFileService,
  createApiWorkspaceRoutes,
  mapFileError,
  setApiWorkspaceDeps,
} from "@fenix/resource-machine/server";
import { initializeMachineModuleConfig, stubMachineEnvironmentRecord } from "@fenix/resource-machine/server/testing";
import Elysia from "elysia";
import { authGuardPlugin, resetTestAuth, setTestAuth } from "../plugins/auth";
import { errorPlugin } from "../plugins/error-handler";

afterEach(() => {
  setApiWorkspaceDeps(null);
  resetAgentConfigModuleForTesting();
  resetTestAuth();
  resetAllStubs();
});
function authenticate() {
  setTestAuth({
    user: { id: "user", email: "user@example.test", name: "user" },
    authContext: { organizationId: "org", userId: "user", role: "owner" },
  });
}
// 全局错误处理先注册，仍需保留统一文件执行面的冲突与离线状态。
test("real host and upload routes preserve file conflict and unavailable statuses", async () => {
  initializeMachineModuleConfig();
  stubMachineEnvironmentRecord({ id: "env", organizationId: "org", userId: "user" });
  authenticate();
  const app = new Elysia().use(errorPlugin).use(createApiWorkspaceRoutes({ authGuardPlugin }));
  for (const [fault, status, code] of [
    [Object.assign(new Error("exists"), { code: "EEXIST" }), 409, "PATH_CONFLICT"],
    [new Error("internal-machine-secret"), 503, "FILE_SERVICE_UNAVAILABLE"],
  ] as const) {
    setApiWorkspaceDeps({
      createAgentFileService: () =>
        ({
          upload: async () => {
            throw mapFileError(fault);
          },
        }) as unknown as AgentFileService,
    });
    const form = new FormData();
    form.append("files", new File(["data"], "input.txt"));
    const response = await app.handle(
      new Request("http://localhost/api/v1/environments/env/workspace/files", { method: "POST", body: form }),
    );
    expect(response.status).toBe(status);
    const body = await readJson(response);
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("internal-machine-secret");
  }
});
// KB 不存在或属于其他组织属于输入错误，不能被宿主先注册的 onError 变成 500。
test("real host and Agent route map inaccessible KB binding to 400", async () => {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
  });
  installAgentConfigModule(createStubAgentConfigServerModule());
  authenticate();
  const app = new Elysia().use(errorPlugin).use(createApiAgentsRoutes({ authGuardPlugin }));
  const response = await app.handle(
    new Request("http://localhost/api/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "invalid-kb",
        knowledge: { knowledgeBaseIds: ["123e4567-e89b-12d3-a456-426614174000"] },
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect((await readJson(response)).error.code).toBe("INVALID_KNOWLEDGE_BINDINGS");
});

// 校验通过后知识库也可能被删除，事务内的领域错误仍应返回同一公开协议。
test("real host maps KB binding failure during atomic save to 400", async () => {
  let bindingAttempted = false;
  const database = {
    execute: async () => [],
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(database),
  };
  initializeTestApplicationInfrastructure({ database });
  installAgentConfigModule(
    createStubAgentConfigServerModule({
      facade: createStubAgentConfigFacade({
        create: async () => ({
          id: "agent",
          name: "demo",
          userId: "user",
          organizationId: "org",
          visibility: "private",
          model: null,
          modelId: null,
          prompt: null,
          description: null,
          extra: null,
          agentNode: {},
          machineId: null,
          engineType: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          scope: { organizationId: "org", ownerUserId: "user", visibility: "private" },
          access: { actions: ["read", "update"] },
        }),
      }),
      associations: createStubAgentAssociations({
        syncKnowledge: async () => {
          bindingAttempted = true;
          throw new InvalidKnowledgeBindingError("internal-kb-id");
        },
      }),
    }),
  );
  authenticate();
  const app = new Elysia().use(errorPlugin).use(createApiAgentsRoutes({ authGuardPlugin }));
  const response = await app.handle(
    new Request("http://localhost/api/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo", knowledge: null }),
    }),
  );
  expect(bindingAttempted).toBe(true);
  expect(response.status).toBe(400);
  expect(await readJson(response)).toEqual({
    success: false,
    error: { code: "INVALID_KNOWLEDGE_BINDINGS", message: "知识库不存在或不可访问" },
  });
});
