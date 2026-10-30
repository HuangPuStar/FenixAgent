import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { KnowledgeBaseRow } from "../server/repositories/knowledge-base";
import { agentKnowledgeBindingRepo, knowledgeBaseRepo } from "../server/repositories/knowledge-base";
import { InvalidKnowledgeBindingError, syncAgentKnowledgeBindingsById } from "../server/services/agent-knowledge";
import { initializeKnowledgeModuleConfig } from "../server/testing";

/**
 * Agent 知识库绑定写入的归属校验。
 *
 * 运行时不按调用方身份再判组织（绑定表就是授权来源），因此「只能绑定本组织知识库」必须在写入时守住，
 * 否则知道知识库 ID 就能把它挂到自己的 Agent 上越权检索。
 */

const NOW = new Date("2026-10-30T00:00:00.000Z");

function knowledgeBaseRow(id: string, organizationId: string): KnowledgeBaseRow {
  return {
    id,
    userId: "owner-1",
    organizationId,
    name: `知识库 ${id}`,
    slug: id,
    description: null,
    provider: "ragflow",
    remoteId: `remote-${id}`,
    remoteAccountId: null,
    remoteUserId: null,
    metadata: null,
    status: "ready" as const,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const originals = {
  getBase: knowledgeBaseRepo.getById,
  deleteBindings: agentKnowledgeBindingRepo.deleteByAgentConfigId,
  createMany: agentKnowledgeBindingRepo.createMany,
};

let createdBindings: Array<{ knowledgeBaseId: string }> = [];

describe("Agent 知识库绑定写入", () => {
  beforeEach(() => {
    initializeKnowledgeModuleConfig();
    knowledgeBaseRepo.getById = mock(async (id: string) =>
      id === "kb-own"
        ? knowledgeBaseRow("kb-own", "org-1")
        : id === "kb-foreign"
          ? knowledgeBaseRow("kb-foreign", "org-2")
          : null,
    ) as unknown as typeof knowledgeBaseRepo.getById;
    agentKnowledgeBindingRepo.deleteByAgentConfigId = mock(
      async () => {},
    ) as unknown as typeof agentKnowledgeBindingRepo.deleteByAgentConfigId;
    agentKnowledgeBindingRepo.createMany = mock(async (rows: Array<{ knowledgeBaseId: string }>) => {
      createdBindings = rows;
    }) as unknown as typeof agentKnowledgeBindingRepo.createMany;
    createdBindings = [];
  });

  afterEach(() => {
    knowledgeBaseRepo.getById = originals.getBase;
    agentKnowledgeBindingRepo.deleteByAgentConfigId = originals.deleteBindings;
    agentKnowledgeBindingRepo.createMany = originals.createMany;
  });

  // 本组织知识库应正常落绑定，顺序即 priority。
  test("写入本组织知识库绑定", async () => {
    await syncAgentKnowledgeBindingsById("agent-1", { knowledgeBaseIds: ["kb-own"] }, "org-1");

    expect(createdBindings.map((row) => row.knowledgeBaseId)).toEqual(["kb-own"]);
  });

  // 其他组织的知识库必须按「无权限访问」拒绝，且整体不落任何绑定（避免半写）。
  test("拒绝其他组织的知识库并保持零写入", async () => {
    await expect(
      syncAgentKnowledgeBindingsById("agent-1", { knowledgeBaseIds: ["kb-own", "kb-foreign"] }, "org-1"),
    ).rejects.toBeInstanceOf(InvalidKnowledgeBindingError);

    expect(createdBindings).toEqual([]);
  });
});
