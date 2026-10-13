// Knowledge 门面层（Facade + access）的授权语义断言：归属判定与凭据身份必须止于这一层。
//
// 与 `./knowledge-base-facade.test.ts`（列表可见范围）、`./round39-knowledge-routes.test.ts`（协议形状）
// 的分工：本文件钉的是三条**语义**——跨组织与不存在同码、资源必须属于其知识库、远端凭据按调用者身份解析。
// 每条断言都把「被反转的判断」暴露出来：把 `knowledgeBaseRepo` 的归属比较、`findResourceInBase` 的成员
// 判定或凭据绑定的身份换成另一种写法，对应用例必须变红（实测见本包交付说明）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createKnowledgeAccess } from "../server/facades/knowledge-access";
import { createKnowledgeBaseFacade } from "../server/facades/knowledge-base-facade";
import { createKnowledgeResourceFacade } from "../server/facades/knowledge-resource-facade";
import { createKnowledgeRuntimeFacade } from "../server/facades/knowledge-runtime-facade";
import {
  type KnowledgeBaseRow,
  type KnowledgeResourceRow,
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "../server/repositories/knowledge-base";
import { RagFlowKnowledgeProvider } from "../server/services/knowledge-provider/ragflow";
import { setKnowledgeProviderForTesting } from "../server/services/knowledge-provider/registry";
import { initializeKnowledgeModuleConfig } from "../server/testing";

const ACTOR = { organizationId: "org-1", userId: "user-1" } as const;
const NOW = new Date("2026-08-19T00:00:00.000Z");

function knowledgeBase(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb-1",
    userId: "owner-2",
    organizationId: "org-1",
    name: "产品文档",
    slug: "product-docs",
    description: null,
    provider: "ragflow",
    remoteId: "remote-kb-1",
    remoteAccountId: null,
    remoteUserId: null,
    metadata: null,
    status: "ready",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resource(overrides: Partial<KnowledgeResourceRow> = {}): KnowledgeResourceRow {
  return {
    id: "resource-1",
    knowledgeBaseId: "kb-1",
    sourceType: "upload",
    sourceName: "guide.md",
    sourcePath: null,
    remoteId: "remote-resource-1",
    status: "ready",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 记录 provider 收到的远端启用入参，用于断言凭据确实来自调用者身份。 */
class RecordingProvider extends RagFlowKnowledgeProvider {
  enabledInput: Parameters<RagFlowKnowledgeProvider["setResourceEnabled"]>[0] | null = null;

  override async setResourceEnabled(input: Parameters<RagFlowKnowledgeProvider["setResourceEnabled"]>[0]) {
    this.enabledInput = input;
  }
}

const originals = {
  getBase: knowledgeBaseRepo.getById,
  getResource: knowledgeResourceRepo.getById,
};

describe("Knowledge 门面的授权语义", () => {
  beforeEach(() => {
    initializeKnowledgeModuleConfig();
  });

  afterEach(() => {
    knowledgeBaseRepo.getById = originals.getBase;
    knowledgeResourceRepo.getById = originals.getResource;
    setKnowledgeProviderForTesting(null);
    resetAllStubs();
  });

  // 跨组织的知识库必须与不存在的知识库**同码同文案**：区分两者会让知识库 ID 变成跨组织探测面。
  test("跨组织的知识库与不存在的知识库返回同一个不可达结果", async () => {
    knowledgeBaseRepo.getById = mock(async (id: string) =>
      id === "kb-foreign" ? knowledgeBase({ id: "kb-foreign", organizationId: "org-foreign" }) : null,
    );

    const foreign = await createKnowledgeBaseFacade().getDetail(ACTOR, "kb-foreign");
    const missing = await createKnowledgeBaseFacade().getDetail(ACTOR, "kb-missing");

    expect(foreign).toEqual(missing);
    expect(foreign).toEqual({
      ok: false,
      error: { kind: "not-found", code: "NOT_FOUND", message: "知识库不存在" },
    });
  });

  // 所有检索和图谱动作在解析凭据前拒绝跨组织资源，与不存在的资源同形。
  test("检索及图谱统一隐藏跨组织知识库且不解析远端凭据", async () => {
    const identities: Array<{ organizationId: string; userId: string }> = [];
    const access = createKnowledgeAccess((identity) => {
      identities.push(identity);
      return async () => "unused-test-key";
    });
    knowledgeBaseRepo.getById = mock(async (id: string) =>
      id === "kb-foreign" ? knowledgeBase({ id, organizationId: "org-foreign" }) : null,
    );
    const facade = createKnowledgeRuntimeFacade(access);
    const actions = [
      (id: string) => facade.search(ACTOR, id, { query: "tenant isolation", topK: 3 }),
      (id: string) => facade.generateGraph(ACTOR, id),
      (id: string) => facade.getGraph(ACTOR, id),
      (id: string) => facade.deleteGraph(ACTOR, id),
      (id: string) => facade.pollGraphProgress(ACTOR, id),
    ];

    for (const action of actions) {
      const foreign = await action("kb-foreign");
      expect(foreign).toEqual(await action("kb-missing"));
      expect(foreign).toMatchObject({ ok: false, error: { kind: "not-found", code: "NOT_FOUND" } });
    }
    expect(identities).toEqual([]);
  });

  // 原文件使用属主上游凭据不代表调用者能绕过组织边界。
  test("远端原文件解析先验证组织归属再绑定属主凭据", async () => {
    const identities: Array<{ organizationId: string; userId: string }> = [];
    const access = createKnowledgeAccess((identity) => {
      identities.push(identity);
      return async () => "test-owner-key";
    });
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ organizationId: "org-foreign" }));

    await expect(access.resolveRemoteFileBase(ACTOR, "kb-1")).resolves.toBeUndefined();
    expect(identities).toEqual([]);

    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    const context = await access.resolveRemoteFileBase(ACTOR, "kb-1");

    expect(context?.kb.id).toBe("kb-1");
    expect(identities).toEqual([{ organizationId: "org-1", userId: "owner-2" }]);
  });

  // 资源不属于路径里的知识库时与不存在同码，且不得触达 provider。
  test("资源不属于该知识库时不可达", async () => {
    const provider = new RecordingProvider();
    setKnowledgeProviderForTesting(provider);
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase());
    knowledgeResourceRepo.getById = mock(async () => resource({ knowledgeBaseId: "kb-other" }));
    const facade = createKnowledgeResourceFacade();

    await expect(facade.setEnabled(ACTOR, "kb-1", "resource-1", true)).resolves.toEqual({
      ok: false,
      error: { kind: "not-found", code: "NOT_FOUND", message: "资源不存在" },
    });
    await expect(facade.reparse(ACTOR, "kb-1", "resource-1", { deleteOld: false })).resolves.toEqual({
      ok: false,
      error: { kind: "not-found", code: "NOT_FOUND", message: "资源不存在" },
    });
    expect(provider.enabledInput).toBeNull();
  });

  // 远端凭据必须按**调用者**身份解析：知识库属主是同组织的另一个人时，也不得拿属主的身份去取 key。
  test("远端凭据按调用者身份解析而不是知识库属主", async () => {
    const identities: Array<{ organizationId: string; userId: string }> = [];
    const access = createKnowledgeAccess((identity) => {
      identities.push(identity);
      return async () => `key-for:${identity.organizationId}/${identity.userId}`;
    });
    const provider = new RecordingProvider();
    setKnowledgeProviderForTesting(provider);
    // 知识库属于同组织的另一个用户（owner-2）：归属放行，但凭据身份仍应是调用者。
    knowledgeBaseRepo.getById = mock(async () => knowledgeBase({ userId: "owner-2" }));
    knowledgeResourceRepo.getById = mock(async () => resource());

    const facade = createKnowledgeResourceFacade(access);
    await expect(facade.setEnabled(ACTOR, "kb-1", "resource-1", true)).resolves.toEqual({
      ok: true,
      data: { enabled: true },
    });

    expect(identities).toEqual([{ organizationId: "org-1", userId: "user-1" }]);
    expect(provider.enabledInput?.apiKey).toBe("key-for:org-1/user-1");
  });
});
