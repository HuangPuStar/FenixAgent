import { litellmRequest } from "./client";

/** LiteLLM member_add 可能返回多种格式，做容错处理 */
interface MemberAddResponse {
  member_id?: string;
  user_id?: string;
  id?: string;
  [key: string]: unknown;
}

export async function addLitellmMember(
  orgId: string,
  userId: string,
  role: "internal_user" | "org_admin" | "internal_user_viewer" = "internal_user",
): Promise<string> {
  const response = await litellmRequest<MemberAddResponse>("POST", "/organization/member_add", {
    organization_id: orgId,
    member: { user_id: userId, role },
  });
  // LiteLLM 不同版本返回字段可能不同，按优先级取
  return response.member_id || response.user_id || response.id || userId;
}

export async function removeLitellmMember(orgId: string, userId: string): Promise<void> {
  await litellmRequest("DELETE", "/organization/member_delete", {
    organization_id: orgId,
    user_id: userId,
  });
}
