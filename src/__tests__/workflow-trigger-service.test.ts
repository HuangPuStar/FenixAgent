import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setConfig } from "../config";
import { resetAllStubs } from "../test-utils/helpers";

// mock repository
const mockRepo = {
  getByHash: mock(() => Promise.resolve(null)),
  getById: mock(() => Promise.resolve(null)),
  create: mock(() => Promise.resolve({} as any)),
  delete: mock(() => Promise.resolve(false)),
  update: mock(() => Promise.resolve()),
  listByWorkflow: mock(() => Promise.resolve([])),
  listByOrg: mock(() => Promise.resolve([])),
};

mock.module("../repositories/workflow-trigger", () => ({
  workflowTriggerRepo: mockRepo,
}));

describe("workflow-trigger-service", () => {
  beforeEach(() => {
    resetAllStubs();
    setConfig({ baseUrl: "http://localhost:3000" });
  });

  afterEach(() => {
    setConfig({ baseUrl: "" });
    mockRepo.getByHash.mockClear();
    mockRepo.getById.mockClear();
    mockRepo.create.mockClear();
    mockRepo.delete.mockClear();
    mockRepo.update.mockClear();
    mockRepo.listByWorkflow.mockClear();
  });

  // createTrigger 生成 hash 并调用 repo.create
  test("createTrigger generates hash and returns webhookUrl", async () => {
    const { createTrigger } = await import("../services/workflow-trigger");
    (mockRepo.create as any).mockImplementation(async (data: any) => ({
      id: "trig-1",
      organizationId: data.organizationId,
      workflowId: data.workflowId,
      type: data.type,
      publicHash: data.publicHash,
      secret: data.secret ?? null,
      config: data.config ?? null,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    const result = await createTrigger({
      organizationId: "org-1",
      workflowId: "wf-1",
      type: "webhook",
      userId: "user-1",
    });

    expect(result.webhookUrl).toContain("/hooks/");
    expect(result.publicHash).toBeDefined();
    expect(result.publicHash.length).toBeGreaterThanOrEqual(32);
    expect(mockRepo.create).toHaveBeenCalled();
  });

  // maskHash 只显示前 6 位
  test("maskHash returns first 6 chars + ***", async () => {
    const { maskHash } = await import("../services/workflow-trigger");
    expect(maskHash("abcdef1234567890")).toBe("abcdef***");
    expect(maskHash("short")).toBe("short***");
  });

  // deleteTrigger 校验归属后删除
  test("deleteTrigger returns false when trigger not found", async () => {
    const { deleteTrigger } = await import("../services/workflow-trigger");
    mockRepo.getById.mockResolvedValueOnce(null);
    const result = await deleteTrigger("trig-1", "org-1");
    expect(result).toBe(false);
  });

  // deleteTrigger 归属不匹配返回 false
  test("deleteTrigger returns false when org mismatch", async () => {
    const { deleteTrigger } = await import("../services/workflow-trigger");
    mockRepo.getById.mockResolvedValueOnce({
      id: "trig-1",
      organizationId: "org-other",
    } as any);
    const result = await deleteTrigger("trig-1", "org-1");
    expect(result).toBe(false);
  });

  // listTriggers 返回 masked 视图
  test("listTriggers returns masked views", async () => {
    const { listTriggers } = await import("../services/workflow-trigger");
    mockRepo.listByWorkflow.mockResolvedValueOnce([
      {
        id: "trig-1",
        organizationId: "org-1",
        workflowId: "wf-1",
        type: "webhook",
        publicHash: "abcdef1234567890abcdef1234567890",
        secret: null,
        config: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    const result = await listTriggers("wf-1");
    expect(result).toHaveLength(1);
    expect(result[0].publicHash).toBe("abcdef***");
    expect(result[0].webhookUrl).toBeNull();
  });

  // handleWebhookRequest trigger 不存在时返回 false
  test("handleWebhookRequest returns false for unknown hash", async () => {
    const { handleWebhookRequest } = await import("../services/workflow-trigger");
    mockRepo.getByHash.mockResolvedValueOnce(null);

    const result = await handleWebhookRequest("nonexistent", {}, {}, {});
    expect(result.accepted).toBe(false);
    expect(result.error).toBe("trigger not found");
  });

  // handleWebhookRequest trigger disabled 时返回 false
  test("handleWebhookRequest returns false for disabled trigger", async () => {
    const { handleWebhookRequest } = await import("../services/workflow-trigger");
    mockRepo.getByHash.mockResolvedValueOnce({
      id: "trig-1",
      enabled: false,
    } as any);

    const result = await handleWebhookRequest("abc", {}, {}, {});
    expect(result.accepted).toBe(false);
  });
});
