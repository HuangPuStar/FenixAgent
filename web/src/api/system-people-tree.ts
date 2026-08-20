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
  role: string | null;
  agents: SystemPeopleAgent[];
}

export interface SystemPeopleOrganization {
  id: string;
  name: string;
  slug: string;
  users: SystemPeopleUser[];
}

export interface CreateSystemUserInput {
  name: string;
  email: string;
  password: string;
}

export interface ResetSystemUserPasswordInput {
  email: string;
  password: string;
}

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
