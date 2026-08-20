import { stringify } from "smol-toml";
import type { ClusterDatabase } from "../db/client";
import { ServerCredentialRepository } from "../repositories/server-credential-repository";
import { ServerRepository } from "../repositories/server-repository";
import { createNodeRegistrationToken } from "../security/node-registration-token";
import type { SecretBox } from "../security/secret-box";
import type { ClusterConfig } from "../types";
import type { ServerService } from "./server-service";

export interface CreateTunnelServerInput {
  id: string;
  pool_id: string;
  name: string;
  workspace_root: string;
  api_key: string;
  max_sandboxes: number;
  status?: string;
}

export interface TunnelSummary {
  serverId: string;
  routeHost: string;
  credentialStatus: "active" | "revoked";
  tokenPrefix: string;
}

export class TunnelConfigService {
  private readonly servers: ServerRepository;
  private readonly credentials: ServerCredentialRepository;

  constructor(
    _db: ClusterDatabase,
    private readonly config: ClusterConfig,
    private readonly secretBox: SecretBox,
    private readonly serverService: ServerService,
  ) {
    this.servers = new ServerRepository(_db);
    this.credentials = new ServerCredentialRepository(_db);
  }

  async prepare(serverId: string): Promise<TunnelSummary> {
    const server = this.servers.findById(serverId);
    if (!server) throw new Error("server not found");
    await this.serverService.ensureOfflineForTunnel(serverId);
    const now = Date.now();
    const routeHost = server.routeHost ?? this.createRouteHost(serverId);
    if (!server.routeHost) this.servers.update(serverId, { routeHost, updatedAt: now });
    let credential = this.credentials.findByServerId(serverId);
    if (!credential) {
      const token = createNodeRegistrationToken(serverId);
      credential = this.credentials.insert({
        serverId,
        tokenHash: token.hash,
        tokenCiphertext: this.secretBox.encryptCredential(token.value),
        tokenPrefix: token.prefix,
        status: "active",
        createdAt: now,
      });
    }
    if (server.transportMode !== "tunnel") {
      this.servers.update(serverId, { transportMode: "tunnel", routeHost, updatedAt: now });
    }
    return { serverId, routeHost, credentialStatus: credential.status, tokenPrefix: credential.tokenPrefix };
  }

  async createTunnelServer(input: CreateTunnelServerInput) {
    const server = this.serverService.create({
      ...input,
      // The existing base_url column is NOT NULL; tunnel rows use an empty value.
      base_url: "",
      transport_mode: "tunnel",
      route_host: this.createRouteHost(input.id),
    });
    await this.prepare(server.id);
    return this.serverService.findById(server.id) ?? server;
  }

  async downloadFrpcToml(serverId: string): Promise<{ filename: string; content: string }> {
    const summary = await this.prepare(serverId);
    const server = this.servers.findById(serverId);
    const credential = this.credentials.findByServerId(serverId);
    if (!server || !credential) throw new Error("tunnel configuration is unavailable");
    const token = this.secretBox.decryptCredential(credential.tokenCiphertext);
    const content = [
      `# credential_status=${credential.status}`,
      stringify({
        serverAddr: this.config.frpPublicAddress,
        serverPort: this.config.frpBindPort,
        loginFailExit: false,
        auth: {
          method: "token",
          token: this.config.frpToken,
          additionalScopes: ["HeartBeats", "NewWorkConns"],
        },
        transport: {
          heartbeatInterval: 10,
          heartbeatTimeout: 30,
          dialServerKeepalive: 30,
          tls: { enable: true },
        },
        metadatas: { server_id: serverId, node_token: token },
        proxies: [
          {
            name: `os-${serverId}`,
            type: "http",
            localIP: "127.0.0.1",
            localPort: 8080,
            customDomains: [summary.routeHost],
          },
        ],
      }),
    ].join("\n");
    return { filename: `${server.name.replace(/[^A-Za-z0-9._-]/g, "-") || serverId}.frpc.toml`, content };
  }

  async rotateToken(serverId: string): Promise<TunnelSummary> {
    const server = this.servers.findById(serverId);
    if (!server) throw new Error("server not found");
    const current = this.credentials.findByServerId(serverId);
    if (!current) {
      await this.prepare(serverId);
      return this.rotateToken(serverId);
    }
    const token = createNodeRegistrationToken(serverId);
    this.credentials.rotate(
      serverId,
      {
        tokenHash: token.hash,
        tokenCiphertext: this.secretBox.encryptCredential(token.value),
        tokenPrefix: token.prefix,
        status: "active",
        revokedAt: null,
      },
      Date.now(),
    );
    return this.prepare(serverId);
  }

  async revokeToken(serverId: string): Promise<TunnelSummary> {
    const result = this.credentials.revoke(serverId, Date.now());
    if (!result) throw new Error("tunnel credential not found");
    return this.prepare(serverId);
  }

  private createRouteHost(serverId: string): string {
    const random = new Uint8Array(8);
    crypto.getRandomValues(random);
    return `os-${Buffer.from(random).toString("hex")}-${serverId.slice(0, 8)}.tunnel.internal`;
  }
}
