import { request } from "./request";

export type AgentMarketplaceItemType = "external" | "published";

export interface AgentMarketplaceItem {
  id: string;
  type: AgentMarketplaceItemType;
  name: string;
  description: string | null;
  icon: string | null;
  tags: string[];
  externalUrl: string | null;
  agentConfigId: string | null;
  publishedAt: string | null;
  canOpen: boolean;
  canViewConfig: boolean;
}

export const agentMarketplaceApi = {
  list: () => request<AgentMarketplaceItem[]>("/web/agent-marketplace", { method: "GET" }),
  publish: (agentName: string) =>
    request<AgentMarketplaceItem>("/web/agent-marketplace/publish", {
      method: "POST",
      body: { agentName },
    }),
  unpublish: (agentConfigId: string) =>
    request<{ ok: true }>("/web/agent-marketplace/published/:agentConfigId", {
      method: "DELETE",
      params: { agentConfigId },
    }),
  getConfig: (id: string) =>
    request<unknown>("/web/agent-marketplace/:id/config", {
      method: "GET",
      params: { id },
    }),
};
