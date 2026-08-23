import type { RemoteSandboxListQuery, SandboxServerCommandBody } from "../../schemas/api-sandbox-server.schema";
import { createSandboxClusterClient, type SandboxClusterFetch } from "./sandbox-cluster-client";

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

function buildListQuery(query: RemoteSandboxListQuery): string {
  const params = new URLSearchParams();
  if (query.state) params.set("state", query.state);
  if (query.metadata) params.set("metadata", query.metadata);
  params.set("page", String(query.page));
  params.set("pageSize", String(query.page_size));
  return params.toString();
}

function sandboxPath(serverId: string, sandboxId: string, suffix = ""): string {
  return `/api/v1/servers/${encodeId(serverId)}/proxy/v1/sandboxes/${encodeId(sandboxId)}${suffix}`;
}

/** 通过 Cluster 代理管理 OpenSandbox Server 上的远程沙盒。 */
export function createSandboxServerAdminService(fetchImpl: SandboxClusterFetch = fetch) {
  const client = createSandboxClusterClient(fetchImpl);

  return {
    listSandboxes: (serverId: string, query: RemoteSandboxListQuery) =>
      client.json<unknown>(`/api/v1/servers/${encodeId(serverId)}/proxy/v1/sandboxes?${buildListQuery(query)}`),
    getSandbox: (serverId: string, sandboxId: string) => client.json<unknown>(sandboxPath(serverId, sandboxId)),
    getDiagnostics: (serverId: string, sandboxId: string) =>
      client.jsonText(sandboxPath(serverId, sandboxId, "/diagnostics/summary")),
    executeCommandStream: (serverId: string, sandboxId: string, body: SandboxServerCommandBody, signal?: AbortSignal) =>
      client.stream(sandboxPath(serverId, sandboxId, "/proxy/44772/command"), {
        method: "POST",
        body: JSON.stringify(body),
        signal,
      }),
  };
}

export type SandboxServerAdminService = ReturnType<typeof createSandboxServerAdminService>;

export const sandboxServerAdminService = createSandboxServerAdminService();
