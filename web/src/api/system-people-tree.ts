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

export function fetchSystemPeopleTree(): Promise<{ organizations: SystemPeopleOrganization[] }> {
  return unwrap(
    request<{ organizations: SystemPeopleOrganization[] }>("/api/system/people-tree/", {
      bearerToken: getAdminKey() ?? undefined,
    }),
  );
}
