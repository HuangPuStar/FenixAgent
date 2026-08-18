import { eq } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { opensandboxServer, opensandboxTunnelConnection } from "../db/schema";
import type { ClusterConfig } from "../types";

export interface ServerTarget {
  baseUrl: string;
  hostHeader?: string;
  transportMode: "direct" | "tunnel";
}

export class ServerTargetError extends Error {
  constructor(
    readonly code: "SERVER_DISCONNECTED" | "SERVER_UNHEALTHY",
    message: string,
  ) {
    super(message);
  }
}

export class ServerTargetResolver {
  constructor(
    private readonly db: ClusterDatabase,
    private readonly config: ClusterConfig,
  ) {}

  resolve(serverId: string, now = Date.now()): ServerTarget {
    const server = this.db.select().from(opensandboxServer).where(eq(opensandboxServer.id, serverId)).get();
    if (!server) throw new ServerTargetError("SERVER_DISCONNECTED", "OpenSandbox Server not found");
    if (server.transportMode === "direct") {
      if (!server.baseUrl)
        throw new ServerTargetError("SERVER_DISCONNECTED", "OpenSandbox Server has no direct address");
      if (server.healthStatus !== "healthy")
        throw new ServerTargetError("SERVER_UNHEALTHY", "OpenSandbox Server is unhealthy");
      return { baseUrl: server.baseUrl, transportMode: "direct" };
    }
    const connection = this.db
      .select()
      .from(opensandboxTunnelConnection)
      .where(eq(opensandboxTunnelConnection.serverId, serverId))
      .get();
    if (connection?.status !== "connected" || connection.lastSeenAt < now - this.config.frpConnectionStaleMs)
      throw new ServerTargetError("SERVER_DISCONNECTED", "OpenSandbox Server tunnel is disconnected");
    if (connection.healthStatus !== "healthy")
      throw new ServerTargetError("SERVER_UNHEALTHY", "OpenSandbox Server tunnel is unhealthy");
    if (!server.routeHost)
      throw new ServerTargetError("SERVER_DISCONNECTED", "OpenSandbox Server tunnel route is unavailable");
    return { baseUrl: this.config.frpInternalUrl, hostHeader: server.routeHost, transportMode: "tunnel" };
  }
}
