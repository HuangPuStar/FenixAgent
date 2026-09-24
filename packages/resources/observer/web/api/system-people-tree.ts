import { request, unwrap } from "@fenix/web-runtime/api/request";
import { getAdminKey } from "@fenix/web-runtime/lib/admin-key";

export interface SystemPeopleAgent {
  id: string;
  name: string;
  description: string | null;
  machineId: string | null;
  engineType: string | null;
}

export interface SystemPeopleUser {
  id: string;
  name: string;
  email: string;
  phoneNumber: string | null;
  role: string | null;
  agents: SystemPeopleAgent[];
}

export interface SystemPeopleOrganization {
  id: string;
  name: string;
  slug: string;
  users: SystemPeopleUser[];
}

export type SystemUserIdentifierType = "email" | "phone";

export type SystemUserIdentifier = { email: string } | { phoneNumber: string };

export function buildSystemUserIdentifier(type: SystemUserIdentifierType, value: string): SystemUserIdentifier {
  const normalizedValue = value.trim();
  return type === "phone" ? { phoneNumber: normalizedValue } : { email: normalizedValue };
}

export type CreateSystemUserInput = {
  name: string;
  password: string;
} & SystemUserIdentifier;

export type ResetSystemUserPasswordInput = {
  password: string;
} & SystemUserIdentifier;

/** 系统人员目录的域模块出口（§5.5：单一 `*Api` 对象；`buildSystemUserIdentifier` 是纯值装配，留在对象外）。 */
export const systemPeopleTreeApi = {
  /** 拉取组织 / 用户 / 智能体三层人员树（Bearer master key）。 */
  fetchTree: (): Promise<{ organizations: SystemPeopleOrganization[] }> =>
    unwrap(
      request<{ organizations: SystemPeopleOrganization[] }>("/api/system/people-tree/", {
        bearerToken: getAdminKey() ?? undefined,
      }),
    ),

  /** 创建系统用户（账号标识为邮箱或手机号二选一）。 */
  createUser: (input: CreateSystemUserInput): Promise<void> =>
    unwrap(
      request<void>("/api/system/users", {
        method: "POST",
        body: input,
        bearerToken: getAdminKey() ?? undefined,
      }),
    ),

  /** 重置系统用户密码。 */
  resetUserPassword: (input: ResetSystemUserPasswordInput): Promise<void> =>
    unwrap(
      request<void>("/api/system/users/reset-password", {
        method: "POST",
        body: input,
        bearerToken: getAdminKey() ?? undefined,
      }),
    ),
};
