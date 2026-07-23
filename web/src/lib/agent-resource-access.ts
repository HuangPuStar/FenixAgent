import type { ResourceAccess } from "../types/config";

export interface AgentResourceLike {
  id?: string;
  name: string;
  resourceAccess?: ResourceAccess;
}

export function getAgentOptionValue(agent: AgentResourceLike) {
  return agent.resourceAccess?.resourceKey ?? agent.id ?? agent.name;
}

export function getAgentConfigLookupKey(agent: AgentResourceLike) {
  return agent.resourceAccess?.resourceKey ?? agent.id ?? agent.name;
}

export function getAgentDisplayName(agent: AgentResourceLike) {
  const source = agent.resourceAccess?.sourceOrganizationName;
  return source ? `${source}/${agent.name}` : agent.name;
}

export function isAgentWritable(agent: AgentResourceLike) {
  return agent.resourceAccess?.writable !== false;
}

export function canManageAgentSharing(agent: AgentResourceLike) {
  return agent.resourceAccess?.manageable === true;
}

export function getAgentAccessBadgeKey(agent: AgentResourceLike) {
  if (agent.resourceAccess?.ownership === "external") return "resource.external";
  if (agent.resourceAccess?.publicReadable) return "resource.public";
  return "resource.internal";
}
