import type { ClusterDatabase } from "../db/client";
import { ServerCredentialRepository } from "../repositories/server-credential-repository";
import { ServerRepository } from "../repositories/server-repository";
import { TunnelConnectionRepository } from "../repositories/tunnel-connection-repository";
import type { FrpPluginMetadata, FrpPluginRequest, PluginResponse } from "../schemas/frp-plugin-schemas";
import { verifyNodeRegistrationToken } from "../security/node-registration-token";

const ACCEPTED_OPS = new Set(["Login", "NewProxy", "Ping", "CloseProxy"]);
const reject = (message: string): PluginResponse => ({ reject: true, reject_reason: message, unchange: true });
const ok: PluginResponse = { reject: false, unchange: true };

export class FrpPluginService {
  private readonly servers: ServerRepository;
  private readonly credentials: ServerCredentialRepository;
  private readonly connections: TunnelConnectionRepository;

  constructor(db: ClusterDatabase) {
    this.servers = new ServerRepository(db);
    this.credentials = new ServerCredentialRepository(db);
    this.connections = new TunnelConnectionRepository(db);
  }

  handle(request: FrpPluginRequest): PluginResponse {
    if (typeof request.op !== "string" || !ACCEPTED_OPS.has(request.op)) return reject("unsupported operation");
    const metadata = this.metadata(request.content);
    if (!metadata) return reject("invalid plugin metadata");
    const server = this.servers.findById(metadata.serverId);
    const credential = this.credentials.findByServerId(metadata.serverId);
    if (!server || !credential || server.status !== "active") return reject("server is unavailable");
    if (credential.status !== "active" || !verifyNodeRegistrationToken(metadata.nodeToken, credential.tokenHash))
      return reject("invalid node credential");
    const now = Date.now();
    this.credentials.touchLastUsed(metadata.serverId, now);
    switch (request.op) {
      case "Login":
        this.connections.upsertLogin(metadata.serverId, metadata.runId, now);
        return ok;
      case "Ping":
        return this.connections.touch(metadata.serverId, metadata.runId, now) ? ok : reject("stale connection");
      case "CloseProxy":
        return this.connections.markDisconnected(metadata.serverId, metadata.runId, now) ? ok : ok;
      case "NewProxy":
        if (!this.validateProxy(request.content, server.routeHost)) return reject("invalid proxy");
        this.connections.markConnected(metadata.serverId, metadata.runId, now);
        return ok;
    }
    return reject("unsupported operation");
  }

  private validateProxy(content: Record<string, unknown> | undefined, routeHost: string | null): boolean {
    if (!content || !routeHost) return false;
    const proxy = (content.proxy ?? content) as Record<string, unknown>;
    const domains = proxy.custom_domains ?? proxy.customDomains;
    const name = typeof proxy.name === "string" ? proxy.name : "";
    const type = proxy.type;
    return (
      type === "http" &&
      name.startsWith("os-") &&
      Array.isArray(domains) &&
      domains.length === 1 &&
      domains[0] === routeHost
    );
  }

  private metadata(content: Record<string, unknown> | undefined): FrpPluginMetadata | undefined {
    const user = (content?.user ?? content) as Record<string, unknown> | undefined;
    const metas = (user?.metas ?? content?.metas) as Record<string, unknown> | undefined;
    const serverId = metas?.server_id;
    const nodeToken = metas?.node_token;
    const runId = content?.run_id ?? content?.runId ?? user?.run_id ?? user?.runId;
    if (typeof serverId !== "string" || typeof nodeToken !== "string" || typeof runId !== "string") return;
    if (serverId.length > 128 || nodeToken.length > 512 || runId.length > 128) return;
    return { serverId, nodeToken, runId };
  }
}
