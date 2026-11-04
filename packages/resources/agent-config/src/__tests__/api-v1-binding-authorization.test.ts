import { afterEach, expect, test } from "bun:test";
import {
  createStubMcpFacade,
  createStubMcpServerModule,
  installMcpServerModule,
  resetMcpServerModuleForTesting,
} from "@fenix/resource-mcp/server/testing";
import {
  createStubSkillFacade,
  createStubSkillServerModule,
  installSkillServerModule,
  resetSkillServerModuleForTesting,
} from "@fenix/resource-skill/server/testing";
import { authorizeAgentBindings } from "../server/facades/agent-binding-authorization";

const actor = {
  kind: "user" as const,
  userId: "user-1",
  activeOrganizationId: "org-1",
  memberships: [{ organizationId: "org-1", role: "owner" as const }],
};
function installBindings(actions: ("read" | "use")[]) {
  const scope = { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" as const };
  installSkillServerModule(
    createStubSkillServerModule({
      facade: createStubSkillFacade({
        getById: async () => ({ id: "skill-1", name: "skill", description: "", path: "", scope, access: { actions } }),
      }),
    }),
  );
  installMcpServerModule(
    createStubMcpServerModule({
      facade: createStubMcpFacade({
        getById: async () => ({
          id: "mcp-1",
          name: "mcp",
          userId: "user-1",
          organizationId: "org-1",
          visibility: "private",
          type: "remote",
          config: { type: "remote", url: "https://mcp.example.test" },
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          scope,
          access: { actions },
        }),
      }),
    }),
  );
}

afterEach(() => {
  resetMcpServerModuleForTesting();
  resetSkillServerModuleForTesting();
});

// 可读资源不等于可供 Agent 使用，绑定必须检查 owner 返回的有效动作。
test("binding rejects readable Skill and MCP without use permission", async () => {
  installBindings(["read"]);
  for (const bindings of [{ skillIds: ["skill-1"] }, { mcpIds: ["mcp-1"] }]) {
    await expect(authorizeAgentBindings(actor, "org-1", bindings)).rejects.toThrow("不可访问");
  }
});

// owner 明确允许 use 后才可保存关联，不额外引入协议自己的角色判断。
test("binding accepts owner-authorized use actions", async () => {
  installBindings(["read", "use"]);
  await authorizeAgentBindings(actor, "org-1", { skillIds: ["skill-1"], mcpIds: ["mcp-1"] });
});
