import { getAdminKey } from "../lib/admin-key";
import { request, unwrap } from "./request";

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

export function createSystemUser(input: CreateSystemUserInput): Promise<void> {
  return unwrap(
    request<void>("/api/system/users", {
      method: "POST",
      body: input,
      bearerToken: getAdminKey() ?? undefined,
    }),
  );
}

export function resetSystemUserPassword(input: ResetSystemUserPasswordInput): Promise<void> {
  return unwrap(
    request<void>("/api/system/users/reset-password", {
      method: "POST",
      body: input,
      bearerToken: getAdminKey() ?? undefined,
    }),
  );
}

export function fetchSystemPeopleTree(): Promise<{ organizations: SystemPeopleOrganization[] }> {
  return unwrap(
    request<{ organizations: SystemPeopleOrganization[] }>("/api/system/people-tree/", {
      bearerToken: getAdminKey() ?? undefined,
    }),
  );
}
