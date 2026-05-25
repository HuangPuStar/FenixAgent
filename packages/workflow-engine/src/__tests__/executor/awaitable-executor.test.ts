/**
 * AuditExecutor + verifyApprovalToken 测试
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { AuditExecutor, verifyApprovalToken } from "../../executor/awaitable-executor";
import type { NodeExecutionContext } from "../../scheduler/dag-scheduler";
import { SuspendedError } from "../../scheduler/dag-scheduler";
import { createInMemoryStorage } from "../../storage/in-memory-storage";
import type { AuditNodeDef } from "../../types/dag";

// ---------- 辅助工具 ----------

const HMAC_SECRET = "test-hmac-secret-key";

/** 创建测试用的 NodeExecutionContext */
function makeCtx(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const storage = createInMemoryStorage();
  return {
    runId: "test-run-001",
    params: {},
    secrets: {},
    resolvedInputs: {},
    signal: AbortSignal.timeout(30_000),
    storage,
    ...overrides,
  };
}

/** 创建审计节点定义 */
function auditNode(overrides?: Partial<AuditNodeDef>): AuditNodeDef {
  return {
    id: "audit-1",
    type: "audit",
    ...overrides,
  };
}

/** 从 SuspendedError 的 displayData 中提取 token 相关字段 */
function extractTokenData(err: SuspendedError) {
  const data = err.displayData as Record<string, unknown>;
  return {
    approvalToken: data.approvalToken as string,
    expiresAt: data.expiresAt as string,
    displayData: data.display_data as unknown,
  };
}

/** 使用 executor 生成 token（通过捕获 SuspendedError） */
async function generateToken(
  executor: AuditExecutor,
  ctx: NodeExecutionContext,
  node: AuditNodeDef,
): Promise<{ approvalToken: string; expiresAt: string; displayData: unknown }> {
  try {
    await executor.execute(node, ctx);
    throw new Error("Should have thrown SuspendedError");
  } catch (err) {
    if (!(err instanceof SuspendedError)) throw err;
    return extractTokenData(err);
  }
}

// ========== AuditExecutor 测试 ==========

describe("AuditExecutor", () => {
  let executor: AuditExecutor;
  let ctx: NodeExecutionContext;

  beforeEach(() => {
    executor = new AuditExecutor(HMAC_SECRET);
    ctx = makeCtx();
  });

  // 执行审计节点 → 抛出 SuspendedError
  test("执行审计节点抛出 SuspendedError", async () => {
    const node = auditNode();

    await expect(executor.execute(node, ctx)).rejects.toThrow(SuspendedError);
    await expect(executor.execute(node, ctx)).rejects.toThrow("Audit node 'audit-1' requires approval");
  });

  // SuspendedError 包含正确的 nodeId
  test("SuspendedError 包含正确的 nodeId", async () => {
    const node = auditNode({ id: "my-audit-node" });

    try {
      await executor.execute(node, ctx);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SuspendedError);
      expect((err as SuspendedError).nodeId).toBe("my-audit-node");
    }
  });

  // SuspendedError 的 displayData 包含 approvalToken 和 expiresAt
  test("SuspendedError 的 displayData 包含 token 和过期时间", async () => {
    const node = auditNode();
    const { approvalToken, expiresAt } = await generateToken(executor, ctx, node);

    expect(approvalToken).toBeDefined();
    expect(typeof approvalToken).toBe("string");
    expect(approvalToken.length).toBeGreaterThan(0);

    expect(expiresAt).toBeDefined();
    // 验证是有效的 ISO 8601 日期，且在未来（约 24 小时后）
    const expiryDate = new Date(expiresAt);
    expect(expiryDate.getTime()).toBeGreaterThan(Date.now());
    expect(expiryDate.getTime() - Date.now()).toBeLessThan(25 * 60 * 60 * 1000); // 不超过 25 小时
  });

  // display_data 透传
  test("display_data 正确透传到 SuspendedError", async () => {
    const displayData = { title: "审批标题", reason: "需要人工确认" };
    const node = auditNode({ display_data: displayData });

    const result = await generateToken(executor, ctx, node);
    expect(result.displayData).toEqual(displayData);
  });

  // 无 display_data 时透传 undefined
  test("无 display_data 时透传 undefined", async () => {
    const node = auditNode(); // 不设置 display_data

    const result = await generateToken(executor, ctx, node);
    expect(result.displayData).toBeUndefined();
  });

  // 自定义 expires_in 覆盖默认 24 小时
  test("自定义 expires_in 覆盖默认过期时间", async () => {
    const node = auditNode({ expires_in: 60_000 }); // 1 分钟

    const { expiresAt } = await generateToken(executor, ctx, node);
    const expiryDate = new Date(expiresAt);
    const diff = expiryDate.getTime() - Date.now();

    // 允许 1 秒误差
    expect(diff).toBeGreaterThan(59_000);
    expect(diff).toBeLessThan(61_000);
  });

  // 非 audit 节点抛出 TypeError
  test("非 audit 节点抛出 TypeError", async () => {
    const shellNode = { id: "shell-1", type: "shell" } as any;

    await expect(executor.execute(shellNode, ctx)).rejects.toThrow(TypeError);
    await expect(executor.execute(shellNode, ctx)).rejects.toThrow(
      "AuditExecutor only handles 'audit' nodes, got 'shell'",
    );
  });

  // 不同 runId 产生不同 token
  test("不同 runId 产生不同 token", async () => {
    const node = auditNode();
    const ctx1 = makeCtx({ runId: "run-A" });
    const ctx2 = makeCtx({ runId: "run-B" });

    const { approvalToken: token1 } = await generateToken(executor, ctx1, node);
    const { approvalToken: token2 } = await generateToken(executor, ctx2, node);

    expect(token1).not.toBe(token2);
  });
});

// ========== verifyApprovalToken 测试 ==========

describe("verifyApprovalToken", () => {
  let executor: AuditExecutor;
  let ctx: NodeExecutionContext;

  beforeEach(() => {
    executor = new AuditExecutor(HMAC_SECRET);
    ctx = makeCtx();
  });

  // 正确 token → valid
  test("正确 token 验证通过", async () => {
    const node = auditNode({ id: "audit-x" });
    const { approvalToken } = await generateToken(executor, ctx, node);

    const result = verifyApprovalToken(approvalToken, ctx.runId, node.id, HMAC_SECRET);
    expect(result.valid).toBe(true);
    expect(result.expired).toBe(false);
  });

  // 错误 token → invalid
  test("错误 token 验证失败", async () => {
    const node = auditNode();
    const { approvalToken } = await generateToken(executor, ctx, node);

    // 修改 token 中的 HMAC 部分
    const wrongToken = `${approvalToken.slice(0, -4)}ffff`;

    const result = verifyApprovalToken(wrongToken, ctx.runId, node.id, HMAC_SECRET);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(false);
  });

  // 错误 runId → invalid
  test("错误 runId 验证失败", async () => {
    const node = auditNode();
    const { approvalToken } = await generateToken(executor, ctx, node);

    const result = verifyApprovalToken(approvalToken, "wrong-run-id", node.id, HMAC_SECRET);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(false);
  });

  // 错误 nodeId → invalid
  test("错误 nodeId 验证失败", async () => {
    const node = auditNode();
    const { approvalToken } = await generateToken(executor, ctx, node);

    const result = verifyApprovalToken(approvalToken, ctx.runId, "wrong-node-id", HMAC_SECRET);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(false);
  });

  // 错误 hmacSecret → invalid
  test("错误 hmacSecret 验证失败", async () => {
    const node = auditNode();
    const { approvalToken } = await generateToken(executor, ctx, node);

    const result = verifyApprovalToken(approvalToken, ctx.runId, node.id, "wrong-secret");
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(false);
  });

  // 过期 token → expired
  test("过期 token 返回 expired=true", async () => {
    // 手动构造一个已过期的 token
    const runId = "run-expired";
    const nodeId = "node-expired";
    const expiresAtMs = Date.now() - 5000; // 5 秒前过期
    const expiresAtHex = expiresAtMs.toString(16);
    const payload = `${runId}:${nodeId}:${expiresAtHex}`;
    const hmacHex = createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
    const expiredToken = `${expiresAtHex}:${hmacHex}`;

    const result = verifyApprovalToken(expiredToken, runId, nodeId, HMAC_SECRET);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(true);
  });

  // 无效 token 格式 → invalid
  test("无效 token 格式返回 invalid", () => {
    const result = verifyApprovalToken("not-a-valid-token", "run", "node", HMAC_SECRET);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(false);
  });

  // 空 token → invalid
  test("空 token 返回 invalid", () => {
    const result = verifyApprovalToken("", "run", "node", HMAC_SECRET);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(false);
  });
});
