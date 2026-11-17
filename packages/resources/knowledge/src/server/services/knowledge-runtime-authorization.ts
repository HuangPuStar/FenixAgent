import type { KnowledgeRuntimeAuthMode } from "../config";

/** Environment secret 解析出的知识运行时身份；字段允许为空由部署模式决定。 */
export interface KnowledgeRuntimeRequestIdentity {
  readonly userId?: string | null;
  readonly organizationId?: string | null;
}

/** 可稳定分类的知识运行时授权拒绝原因。 */
export type KnowledgeRuntimeAccessErrorCode =
  | "KNOWLEDGE_RUNTIME_IDENTITY_REQUIRED"
  | "KNOWLEDGE_RUNTIME_ORGANIZATION_REQUIRED"
  | "KNOWLEDGE_ORGANIZATION_MISMATCH"
  | "KNOWLEDGE_BINDING_REQUIRED"
  | "KNOWLEDGE_BASE_UNAVAILABLE";

/** 知识运行时授权错误；MCP 调用方仍只看到安全文案，内部日志与测试可稳定识别 code。 */
export class KnowledgeRuntimeAccessError extends Error {
  readonly code: KnowledgeRuntimeAccessErrorCode;

  constructor(code: KnowledgeRuntimeAccessErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeRuntimeAccessError";
    this.code = code;
  }
}

/** 一次请求解析后的授权范围。 */
export interface KnowledgeRuntimeAccessScope {
  readonly mode: KnowledgeRuntimeAuthMode;
  readonly trustedDelegate: boolean;
  readonly userId: string | null;
  readonly organizationId: string | null;
}

function nonBlank(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

/**
 * 解析运行时授权范围。
 *
 * `owner` 不引入新限制，保持 CE 当前公开 Agent 的跨组织绑定语义；`trusted-delegate` 只在调用方
 * 明确要求外部授权门控时启用，缺失身份或组织必须失败关闭。
 */
export function resolveKnowledgeRuntimeAccessScope(
  mode: KnowledgeRuntimeAuthMode,
  identity: KnowledgeRuntimeRequestIdentity,
): KnowledgeRuntimeAccessScope {
  const userId = nonBlank(identity.userId);
  const organizationId = nonBlank(identity.organizationId);
  if (mode === "owner") {
    return Object.freeze({ mode, trustedDelegate: false, userId, organizationId });
  }
  if (!userId) {
    throw new KnowledgeRuntimeAccessError(
      "KNOWLEDGE_RUNTIME_IDENTITY_REQUIRED",
      "Knowledge runtime user identity is required",
    );
  }
  if (!organizationId) {
    throw new KnowledgeRuntimeAccessError(
      "KNOWLEDGE_RUNTIME_ORGANIZATION_REQUIRED",
      "Knowledge runtime organization is required",
    );
  }
  return Object.freeze({ mode, trustedDelegate: true, userId, organizationId });
}

/**
 * 严格交集：`trusted-delegate` 下任一绑定知识库缺组织或跨组织，整次请求拒绝。
 * 在过滤远端未同步行之前执行，避免无效行成为组织边界的旁路。
 */
export function assertKnowledgeRuntimeBindingsInScope(
  access: KnowledgeRuntimeAccessScope,
  bindings: ReadonlyArray<{ readonly id: string; readonly organizationId: string | null | undefined }>,
): void {
  if (!access.trustedDelegate) return;
  const invalid = bindings.find((binding) => nonBlank(binding.organizationId) !== access.organizationId);
  if (invalid) {
    throw new KnowledgeRuntimeAccessError(
      "KNOWLEDGE_ORGANIZATION_MISMATCH",
      `Knowledge base ${invalid.id} is outside the runtime organization`,
    );
  }
}
