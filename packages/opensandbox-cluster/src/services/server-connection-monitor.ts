import type { ClusterDatabase } from "../db/client";
import { opensandboxServer } from "../db/schema";
import { TunnelConnectionRepository } from "../repositories/tunnel-connection-repository";
import type { SecretBox } from "../security/secret-box";
import type { ClusterConfig } from "../types";
import { ServerTargetResolver } from "./server-target-resolver";

export class ServerConnectionMonitor {
  private readonly connections: TunnelConnectionRepository;
  private readonly resolver: ServerTargetResolver;
  private staleTimer?: ReturnType<typeof setInterval>;
  private healthTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly db: ClusterDatabase,
    private readonly config: ClusterConfig,
    private readonly secretBox: SecretBox,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.connections = new TunnelConnectionRepository(db);
    this.resolver = new ServerTargetResolver(db, config);
  }

  start(): void {
    this.reconcileStartup();
    this.staleTimer = setInterval(() => this.sweepStale(), Math.min(this.config.frpConnectionStaleMs, 10000));
    this.healthTimer = setInterval(() => void this.checkConnected(), this.config.frpHealthIntervalMs);
  }

  stop(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.staleTimer = undefined;
    this.healthTimer = undefined;
  }

  reconcileStartup(now = Date.now()): void {
    this.connections.markAllDisconnected(now);
  }

  sweepStale(now = Date.now()): number {
    return this.connections.markStaleDisconnected(now - this.config.frpConnectionStaleMs, now);
  }

  async checkConnected(now = Date.now()): Promise<void> {
    const rows = this.db
      .select()
      .from(opensandboxServer)
      .all()
      .filter((server) => server.transportMode === "tunnel");
    await Promise.all(rows.map((server) => this.checkServer(server.id, now)));
  }

  async checkServer(serverId: string, now = Date.now()): Promise<"unknown" | "healthy" | "unhealthy"> {
    const connection = this.connections.findByServerId(serverId);
    if (connection?.status !== "connected") return "unknown";
    const server = this.db
      .select()
      .from(opensandboxServer)
      .all()
      .find((row) => row.id === serverId);
    if (!server) return "unknown";
    try {
      const target = this.resolver.resolve(serverId, now);
      const response = await this.fetchImpl(new URL("/health", target.baseUrl), {
        headers: {
          Host: target.hostHeader ?? "",
          "OPEN-SANDBOX-API-KEY": this.secretBox.decryptApiKey(server.apiKeyCiphertext),
        },
        signal: AbortSignal.timeout(3000),
      });
      const health = response.ok ? "healthy" : "unhealthy";
      this.connections.updateHealth(
        serverId,
        connection.frpRunId,
        health,
        now,
        response.ok ? undefined : `HTTP ${response.status}`,
      );
      return health;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 256) : "health check failed";
      this.connections.updateHealth(serverId, connection.frpRunId, "unhealthy", now, message);
      return "unhealthy";
    }
  }
}
