import { and, asc, count, eq } from "drizzle-orm";
import type { ClusterDatabase } from "../db/client";
import { sandboxBinding } from "../db/schema";
import type { AllocationService } from "./allocation-service";

/** Bounded management queries over durable sandbox allocations. */
export class SandboxManagementService {
  constructor(
    private readonly db: ClusterDatabase,
    private readonly allocations: AllocationService,
  ) {}

  /** Return a bounded view of durable bindings, including resource lifecycle history. */
  list(query: {
    pool_id?: string;
    server_id?: string;
    allocation_mode?: string;
    state?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where = and(
      query.pool_id ? eq(sandboxBinding.poolId, query.pool_id) : undefined,
      query.server_id ? eq(sandboxBinding.serverId, query.server_id) : undefined,
      query.allocation_mode ? eq(sandboxBinding.allocationMode, query.allocation_mode) : undefined,
      query.state ? eq(sandboxBinding.state, query.state) : undefined,
    );
    const total = this.db.select({ total: count() }).from(sandboxBinding).where(where).get()!.total;
    const rows = this.db
      .select()
      .from(sandboxBinding)
      .where(where)
      .orderBy(asc(sandboxBinding.sandboxId))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();
    return {
      items: rows.map((row) => ({
        ...this.allocations.find(row.sandboxId)!,
        resources: [row.cpu, row.memoryMb, row.diskGb, row.gpuCount].some((value) => value !== null)
          ? { cpu: row.cpu, memoryMb: row.memoryMb, diskGb: row.diskGb, gpuCount: row.gpuCount }
          : null,
        created_at: row.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }
}
