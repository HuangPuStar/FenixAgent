import { litellmRequest } from "./client";

export async function addLitellmMember(
  orgId: string,
  userId: string,
  role: "user" | "admin" = "user",
): Promise<{ member_id: string }> {
  return litellmRequest<{ member_id: string }>("POST", "/organization/member_add", {
    organization_id: orgId,
    member: { user_id: userId, role },
  });
}

export async function removeLitellmMember(orgId: string, userId: string): Promise<void> {
  await litellmRequest("DELETE", "/organization/member_delete", {
    organization_id: orgId,
    user_id: userId,
  });
}
