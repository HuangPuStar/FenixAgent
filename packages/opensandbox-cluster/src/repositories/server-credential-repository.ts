import { eq } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { type NewOpenSandboxServerCredential, opensandboxServerCredential } from "../db/schema";

export class ServerCredentialRepository {
  constructor(private readonly db: ClusterDatabase) {}

  findByServerId(serverId: string) {
    return this.db
      .select()
      .from(opensandboxServerCredential)
      .where(eq(opensandboxServerCredential.serverId, serverId))
      .get();
  }

  insert(value: NewOpenSandboxServerCredential) {
    return this.db.insert(opensandboxServerCredential).values(value).returning().get();
  }

  rotate(serverId: string, value: Omit<NewOpenSandboxServerCredential, "serverId" | "createdAt">, now: number) {
    return this.db
      .update(opensandboxServerCredential)
      .set({ ...value, rotatedAt: now, status: "active" })
      .where(eq(opensandboxServerCredential.serverId, serverId))
      .returning()
      .get();
  }

  revoke(serverId: string, now: number) {
    return this.db
      .update(opensandboxServerCredential)
      .set({ status: "revoked", revokedAt: now })
      .where(eq(opensandboxServerCredential.serverId, serverId))
      .returning()
      .get();
  }

  touchLastUsed(serverId: string, now: number): boolean {
    return (
      this.db
        .update(opensandboxServerCredential)
        .set({ lastUsedAt: now })
        .where(eq(opensandboxServerCredential.serverId, serverId))
        .returning({ serverId: opensandboxServerCredential.serverId })
        .get() !== undefined
    );
  }
}
