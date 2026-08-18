import { and, eq, lt } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { type HealthStatus, type OpenSandboxTunnelConnection, opensandboxTunnelConnection } from "../db/schema";

export class TunnelConnectionRepository {
  constructor(private readonly db: ClusterDatabase) {}

  findByServerId(serverId: string) {
    return this.db
      .select()
      .from(opensandboxTunnelConnection)
      .where(eq(opensandboxTunnelConnection.serverId, serverId))
      .get();
  }

  upsertLogin(serverId: string, runId: string, now: number) {
    const existing = this.findByServerId(serverId);
    if (existing) {
      return this.db
        .update(opensandboxTunnelConnection)
        .set({
          frpRunId: runId,
          status: "connecting",
          connectedAt: null,
          disconnectedAt: null,
          lastSeenAt: now,
          healthStatus: "unknown",
          lastHealthAt: null,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(opensandboxTunnelConnection.serverId, serverId))
        .returning()
        .get();
    }
    return this.db
      .insert(opensandboxTunnelConnection)
      .values({
        serverId,
        frpRunId: runId,
        status: "connecting",
        lastSeenAt: now,
        healthStatus: "unknown",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
  }

  markConnected(serverId: string, runId: string, now: number) {
    return this.updateRun(serverId, runId, {
      status: "connected",
      connectedAt: now,
      disconnectedAt: null,
      lastSeenAt: now,
      updatedAt: now,
    });
  }

  touch(serverId: string, runId: string, now: number) {
    return this.updateRun(serverId, runId, { lastSeenAt: now, updatedAt: now });
  }

  markDisconnected(serverId: string, runId: string, now: number, error?: string) {
    return this.updateRun(serverId, runId, {
      status: "disconnected",
      disconnectedAt: now,
      lastSeenAt: now,
      lastError: error ?? null,
      updatedAt: now,
    });
  }

  markAllDisconnected(now: number): number {
    return this.db
      .update(opensandboxTunnelConnection)
      .set({ status: "disconnected", disconnectedAt: now, updatedAt: now })
      .where(eq(opensandboxTunnelConnection.status, "connected"))
      .returning({ serverId: opensandboxTunnelConnection.serverId })
      .all().length;
  }

  markStaleDisconnected(cutoff: number, now: number): number {
    return this.db
      .update(opensandboxTunnelConnection)
      .set({ status: "disconnected", disconnectedAt: now, lastError: "connection lease expired", updatedAt: now })
      .where(
        and(lt(opensandboxTunnelConnection.lastSeenAt, cutoff), eq(opensandboxTunnelConnection.status, "connected")),
      )
      .returning({ serverId: opensandboxTunnelConnection.serverId })
      .all().length;
  }

  updateHealth(serverId: string, runId: string, health: HealthStatus, now: number, error?: string) {
    return this.updateRun(serverId, runId, {
      healthStatus: health,
      lastHealthAt: now,
      lastError: error ?? null,
      updatedAt: now,
    });
  }

  private updateRun(serverId: string, runId: string, value: Partial<OpenSandboxTunnelConnection>): boolean {
    return (
      this.db
        .update(opensandboxTunnelConnection)
        .set(value)
        .where(and(eq(opensandboxTunnelConnection.serverId, serverId), eq(opensandboxTunnelConnection.frpRunId, runId)))
        .returning({ serverId: opensandboxTunnelConnection.serverId })
        .get() !== undefined
    );
  }
}
