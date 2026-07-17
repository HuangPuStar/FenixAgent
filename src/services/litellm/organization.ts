import { litellmRequest } from "./client";

export interface LitellmOrganization {
  organization_id: string;
  organization_alias?: string;
  budget_id?: string;
  created_at?: string;
  spend?: number;
}

export async function createLitellmOrg(alias: string): Promise<LitellmOrganization> {
  return litellmRequest<LitellmOrganization>("POST", "/organization/new", {
    organization_alias: alias,
  });
}

export async function getLitellmOrg(orgId: string): Promise<LitellmOrganization> {
  return litellmRequest<LitellmOrganization>("GET", `/organization/info?organization_id=${orgId}`);
}
