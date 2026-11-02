import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDatabase } from "@fenix/platform-sdk/server";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { InvalidKnowledgeBindingError } from "@fenix/resource-knowledge/server";
import { createApiAgentsRoutes } from "../server/routes/api/agents";
import { createWebConfigAgentsRoutes } from "../server/routes/web/config/agents";
import { initializeAgentConfigModuleConfig } from "../server/testing";
import {
  authorizedAgent,
  createTestAgentPreferencesPort,
  installAgentModuleStub,
  resetAgentModuleStub,
} from "./fixtures";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

interface SaveState {
  agent: { description: string; publicReadable: boolean } | null;
  knowledge: string[];
  skills: string[];
  memory: boolean;
}

const ID = "11111111-1111-4111-8111-111111111111";
const api = createApiAgentsRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });
const web = createWebConfigAgentsRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(),
  userAgentPreferences: createTestAgentPreferencesPort(),
});
const cases = [
  { label: "Web 创建", route: web, path: "/config/agents", method: "POST", create: true, web: true },
  { label: "Web 更新", route: web, path: `/config/agents/${ID}`, method: "PATCH", create: false, web: true },
  { label: "API 创建", route: api, path: "/api/agents", method: "POST", create: true, web: false },
  { label: "API 更新", route: api, path: `/api/agents/${ID}`, method: "PUT", create: false, web: false },
] as const;

let state: SaveState;
let failure: "knowledge" | "mcp" | null;

/** 所有仓储替身读取平台的真实事务上下文，失败的事务不会把工作副本提交到根状态。 */
function current(): SaveState {
  return getDatabase<{ state: SaveState }>().state;
}

beforeEach(() => {
  initializeAgentConfigModuleConfig();
  setTestAuth({ organizationId: "org-1", userId: "user-1" });
  failure = null;
  state = { agent: null, knowledge: ["kb-old"], skills: ["skill-old"], memory: false };
  stubDb({
    get state() {
      return state;
    },
    transaction: async (callback: (tx: { state: SaveState; execute: () => Promise<void> }) => Promise<unknown>) => {
      const tx = { state: structuredClone(state), execute: async () => {} };
      const result = await callback(tx);
      state = tx.state;
      return result;
    },
  });
  const saved = () =>
    authorizedAgent({
      id: ID,
      name: "atomic-agent",
      description: current().agent?.description ?? "",
      visibility: current().agent?.publicReadable ? "public" : "private",
    });
  installAgentModuleStub({
    facade: {
      existsInOrganization: async () => false,
      create: async (_actor, input) => {
        current().agent = { description: input.data.description ?? "", publicReadable: input.publicReadable ?? false };
        return saved();
      },
      updateById: async (_actor, _id, data, options) => {
        current().agent = { description: data.description ?? "", publicReadable: options?.publicReadable ?? false };
        return saved();
      },
      update: async (_actor, _key, data, options) => {
        current().agent = { description: data.description ?? "", publicReadable: options?.publicReadable ?? false };
        return saved();
      },
    },
    associations: {
      syncKnowledge: async (_id, knowledge) => {
        if (failure === "knowledge") throw new InvalidKnowledgeBindingError("知识库不存在或无权限访问");
        current().knowledge = knowledge?.knowledgeBaseIds ?? [];
      },
      syncSkills: async (_id, ids) => {
        current().skills = [...ids];
      },
      syncMcps: async () => {
        if (failure === "mcp") throw new Error("MCP binding insert failed");
      },
      setMemoryEnabled: async (_id, enabled) => {
        current().memory = enabled;
      },
      listSkillIds: async () => [],
      listMcpIds: async () => [],
      listSiteAppIds: async () => [],
      listKnowledgeBindings: async () => [],
      getKnowledge: async () => null,
      isMemoryEnabled: async () => current().memory,
    },
  });
});

afterEach(() => {
  resetAgentModuleStub();
  resetTestAuth();
  resetAllStubs();
});

for (const entry of cases) {
  describe(entry.label, () => {
    async function save(): Promise<Response> {
      const data = {
        description: "after",
        publicReadable: true,
        enableMemory: true,
        knowledge: { knowledgeBaseIds: ["kb-new"] },
        skillIds: [],
        mcpIds: [],
      };
      return entry.route.handle(
        new Request(`http://localhost${entry.path}`, {
          method: entry.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(entry.web ? { name: "atomic-agent", data } : { name: "atomic-agent", ...data }),
        }),
      );
    }

    // 绑定校验失败时，创建不留下 Agent，更新不改变原配置、公开状态或记忆开关。
    test("非法知识库使整次保存回滚", async () => {
      if (!entry.create) state.agent = { description: "before", publicReadable: false };
      const before = structuredClone(state);
      failure = "knowledge";
      const response = await save();
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_KNOWLEDGE_BINDINGS");
      expect(state).toEqual(before);
    });

    // 后续绑定写入失败也必须撤销之前已成功写入的知识库、Skill 和 Agent 配置。
    test("后续绑定失败不留下部分修改", async () => {
      if (!entry.create) state.agent = { description: "before", publicReadable: false };
      const before = structuredClone(state);
      failure = "mcp";
      const response = await save();
      expect(response.status).toBe(500);
      expect(state).toEqual(before);
    });

    // 合法保存必须真正提交，不能为避免半写而把所有请求都回滚或跳过绑定。
    test("成功时配置和绑定一起提交", async () => {
      const response = await save();
      expect(response.status).toBe(200);
      expect(state.agent).toEqual({ description: "after", publicReadable: true });
      expect(state.knowledge).toEqual(["kb-new"]);
      expect(state.skills).toEqual([]);
      if (entry.web) expect(state.memory).toBe(true);
    });
  });
}
