/**
 * 审计节点执行器 — 支持 SUSPENDED 状态和 HMAC 签名审批 token。
 *
 * 职责：
 * - 生成 HMAC-SHA256 签名的审批 token（含过期时间）
 * - 发射 audit.requested 事件
 * - 抛出 SuspendedError 使 DAG 进入 SUSPENDED 状态
 * - 提供 token 验证函数供 engine facade 使用
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { NodeExecutionContext } from "../scheduler/dag-scheduler";
import { SuspendedError } from "../scheduler/dag-scheduler";
import type { AuditNodeDef, NodeDef } from "../types/dag";

// ---------- 常量 ----------

const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 小时

// ---------- PendingApproval ----------

/** 待审批记录 */
export interface PendingApproval {
  runId: string;
  nodeId: string;
  approvalToken: string;
  expiresAt: string; // ISO 8601
  displayData?: unknown;
}

// ---------- Token 格式 ----------
// 格式: <expiresAt_ms_hex>:<hmac_hex>
// HMAC payload: <runId>:<nodeId>:<expiresAt_ms_hex>

const TOKEN_SEPARATOR = ":";

/** 从 token 字符串中提取 expiresAt 时间戳（16进制） */
function extractExpiresAtHex(token: string): string | null {
  const idx = token.indexOf(TOKEN_SEPARATOR);
  if (idx === -1) return null;
  return token.slice(0, idx);
}

// ---------- AuditExecutor ----------

/** 审计节点执行器 */
export class AuditExecutor {
  constructor(private hmacSecret: string) {}

  async execute(node: NodeDef, ctx: NodeExecutionContext): Promise<never> {
    if (node.type !== "audit") {
      throw new TypeError(`AuditExecutor only handles 'audit' nodes, got '${node.type}'`);
    }

    const auditNode = node as AuditNodeDef;
    const { runId } = ctx;

    // 计算过期时间
    const expiresInMs = auditNode.expires_in ?? DEFAULT_EXPIRY_MS;
    const expiresAtMs = Date.now() + expiresInMs;
    const expiresAtHex = expiresAtMs.toString(16);

    // 生成 HMAC-SHA256 签名
    const payload = `${runId}${TOKEN_SEPARATOR}${node.id}${TOKEN_SEPARATOR}${expiresAtHex}`;
    const hmacHex = createHmac("sha256", this.hmacSecret).update(payload).digest("hex");
    const approvalToken = `${expiresAtHex}${TOKEN_SEPARATOR}${hmacHex}`;

    const expiresAt = new Date(expiresAtMs).toISOString();

    // 抛出 SuspendedError（scheduler 会捕获并设置 SUSPENDED 状态）
    throw new SuspendedError(`Audit node '${node.id}' requires approval`, node.id, {
      approvalToken,
      expiresAt,
      display_data: auditNode.display_data,
    });
  }
}

// ---------- Token 验证 ----------

/** 验证审批 token 的有效性 */
export function verifyApprovalToken(
  token: string,
  runId: string,
  nodeId: string,
  hmacSecret: string,
): { valid: boolean; expired: boolean } {
  // 提取 expiresAt
  const expiresAtHex = extractExpiresAtHex(token);
  if (!expiresAtHex) {
    return { valid: false, expired: false };
  }

  // 检查过期
  const expiresAtMs = Number.parseInt(expiresAtHex, 16);
  if (Number.isNaN(expiresAtMs) || Date.now() > expiresAtMs) {
    return { valid: false, expired: true };
  }

  // 重新计算 HMAC 并比较
  const payload = `${runId}${TOKEN_SEPARATOR}${nodeId}${TOKEN_SEPARATOR}${expiresAtHex}`;
  const expectedHmacHex = createHmac("sha256", hmacSecret).update(payload).digest("hex");

  // 提取 token 中的 HMAC 部分
  const separatorIdx = token.indexOf(TOKEN_SEPARATOR);
  const actualHmacHex = token.slice(separatorIdx + 1);

  // 恒定时间比较，防止时序攻击
  const valid = timingSafeEqualHex(actualHmacHex, expectedHmacHex);
  return { valid, expired: false };
}

/** 恒定时间字符串比较（hex 字符串） */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return timingSafeEqual(bufA, bufB);
}
