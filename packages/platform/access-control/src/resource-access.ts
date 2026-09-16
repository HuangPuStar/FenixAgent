/** Unified ownership and authorization metadata returned with a resource. */
export interface ResourceAccess {
  ownership: "internal" | "external";
  sourceOrganizationId: string;
  sourceOrganizationName?: string;
  resourceUid: string;
  resourceKey: string;
  manageable: boolean;
  writable: boolean;
  publicReadable?: boolean;
}

/** Minimum persisted row shape needed to add resource access metadata. */
export interface ResourceAccessInput {
  id: string;
  organizationId: string;
  name?: string | null;
}
