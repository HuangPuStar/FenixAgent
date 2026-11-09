import { APIError } from "better-auth";
import type { OrganizationDetail, OrganizationInfo, OrganizationMember } from "../../schemas/organization.schema";

/** BetterAuth 成员在 Web 协议转换中使用的字段。 */
export type BetterAuthMember = {
  id: string;
  userId: string;
  role: string;
  organizationId?: string;
  createdAt?: string | number | Date;
  user?: { id: string; name: string; email: string; phoneNumber?: string | null; image?: string | null };
};

/** BetterAuth 组织原始返回值；日期在 Web 边界单独序列化。 */
export type BetterAuthOrganization = {
  id: string;
  name: string;
  slug: string;
  logo?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string | number | Date;
  members?: BetterAuthMember[];
  [key: string]: unknown;
};

/** 序列化框架日期对象，并保留已经符合 Web 契约的字符串或时间戳。 */
function toFlexibleDateTime(value: string | number | Date): string | number {
  return value instanceof Date ? value.toISOString() : value;
}

/** 将 BetterAuth 成员转换为组织 Web DTO。 */
export function serializeMember(member: BetterAuthMember): OrganizationMember {
  return {
    id: member.id,
    userId: member.userId,
    role: member.role,
    organizationId: member.organizationId,
    user: member.user
      ? {
          id: member.user.id,
          name: member.user.name,
          email: member.user.email,
          phoneNumber: member.user.phoneNumber ?? null,
        }
      : undefined,
  };
}

/** 将组织日期转为 Web DTO 支持的格式。 */
export function serializeOrganizationInfo(organization: BetterAuthOrganization & { role?: string }): OrganizationInfo {
  return {
    ...organization,
    createdAt: toFlexibleDateTime(organization.createdAt),
    role: organization.role,
  };
}

/** 组合组织与成员 DTO，避免向响应泄漏框架日期对象。 */
export function serializeOrganizationDetail(
  organization: BetterAuthOrganization,
  members: BetterAuthMember[],
): OrganizationDetail {
  return {
    ...serializeOrganizationInfo(organization),
    members: members.map(serializeMember),
  };
}

/** 统一抽取 better-auth 返回的成员列表。 */
export function extractMembers(res: unknown): {
  id: string;
  userId: string;
  role: string;
  user?: { id: string; name: string; email: string; phoneNumber?: string | null };
}[] {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object" && "members" in res)
    return (
      res as {
        members: Array<{
          id: string;
          userId: string;
          role: string;
          user?: { id: string; name: string; email: string; phoneNumber?: string | null };
        }>;
      }
    ).members;
  return [];
}

/** BetterAuth 的成员拒绝是 APIError；只转换其明确的权限/隐藏资源状态，其他异常继续上抛。 */
export function organizationReadError(err: unknown) {
  if (!(err instanceof APIError)) return null;
  if (err.statusCode === 403) {
    return {
      status: 403 as const,
      body: { success: false as const, error: { code: "FORBIDDEN", message: "Access denied" } },
    };
  }
  if (err.statusCode === 404) {
    return {
      status: 404 as const,
      body: { success: false as const, error: { code: "NOT_FOUND", message: "Organization not found" } },
    };
  }
  return null;
}
