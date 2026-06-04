import type { ResourceAccess } from "../types/config";

export interface McpResourceLike {
  name: string;
  resourceAccess?: ResourceAccess;
}

export function getMcpKey(server: McpResourceLike) {
  return server.resourceAccess?.resourceKey ?? server.name;
}

export function getMcpLookupKey(server: McpResourceLike) {
  return server.resourceAccess?.resourceKey ?? server.name;
}

export function canWriteMcp(server: McpResourceLike) {
  return server.resourceAccess?.writable !== false;
}

export function canManageMcpSharing(server: McpResourceLike) {
  return server.resourceAccess?.manageable === true;
}

export function filterWritableMcps<T extends McpResourceLike>(servers: T[]) {
  return servers.filter((server) => canWriteMcp(server));
}

export function getMcpResourceBadgeKey(server: McpResourceLike) {
  if (server.resourceAccess?.ownership === "external") return "resource.external";
  if (server.resourceAccess?.publicReadable) return "resource.public";
  return "resource.internal";
}

export function getMcpDisplayName(server: McpResourceLike) {
  const source = server.resourceAccess?.sourceOrganizationName;
  return source ? `${source}/${server.name}` : server.name;
}
