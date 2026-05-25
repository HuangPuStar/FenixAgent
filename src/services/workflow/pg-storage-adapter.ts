/**
 * PostgreSQL StorageAdapter 实现。
 *
 * 基于 Drizzle ORM + PostgreSQL，通过 organizationId 实现多租户隔离。
 * 使用事件溯源模式：workflowEvent 存储事件流，workflowSnapshot 存储状态快照，
 * workflowNodeOutput 存储节点输出。
 */

import type {
  DAGEvent,
  DAGSnapshot,
  DAGStatus,
  EventType,
  NodeOutput,
  NodeType,
  RunSummary,
  StorageAdapter,
} from "@mothership/workflow-engine";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import { workflowEvent, workflowNodeOutput, workflowSnapshot } from "../../db/schema";

/** 创建 PostgreSQL 存储适配器，所有查询限定在指定 team 内 */
export function createPgStorageAdapter(organizationId: string): StorageAdapter {
  return {
    // ---------- 事件 ----------

    /** 追加一条 DAG 事件到事件流 */
    async appendEvent(event: DAGEvent): Promise<void> {
      await db.insert(workflowEvent).values({
        eventId: event.event_id,
        runId: event.run_id,
        projectId: event.project_id,
        nodeId: event.node_id,
        timestamp: new Date(event.timestamp),
        type: event.type,
        nodeType: event.node_type,
        metadata: event.metadata ?? null,
        organizationId,
      });
    },

    /** 查询事件流，支持 afterEventId / nodeId / types 组合过滤 */
    async getEvents(
      runId: string,
      opts?: { afterEventId?: string; nodeId?: string; types?: EventType[] },
    ): Promise<DAGEvent[]> {
      const conditions = [eq(workflowEvent.runId, runId), eq(workflowEvent.organizationId, organizationId)];

      // afterEventId：找到该事件的 createdAt，然后取之后的事件
      if (opts?.afterEventId) {
        const [anchor] = await db
          .select({ createdAt: workflowEvent.createdAt })
          .from(workflowEvent)
          .where(
            and(
              eq(workflowEvent.runId, runId),
              eq(workflowEvent.eventId, opts.afterEventId),
              eq(workflowEvent.organizationId, organizationId),
            ),
          )
          .limit(1);

        if (anchor) {
          conditions.push(sql`${workflowEvent.createdAt} > ${anchor.createdAt}`);
        } else {
          // 找不到锚点事件，返回空
          return [];
        }
      }

      if (opts?.nodeId) {
        conditions.push(eq(workflowEvent.nodeId, opts.nodeId));
      }

      if (opts?.types && opts.types.length > 0) {
        conditions.push(inArray(workflowEvent.type, opts.types));
      }

      const rows = await db
        .select()
        .from(workflowEvent)
        .where(and(...conditions))
        .orderBy(workflowEvent.createdAt);

      return rows.map(mapRowToEvent);
    },

    // ---------- 快照 ----------

    /** 获取指定运行最新的快照，不存在返回 null */
    async getLatestSnapshot(runId: string): Promise<DAGSnapshot | null> {
      const [row] = await db
        .select()
        .from(workflowSnapshot)
        .where(and(eq(workflowSnapshot.runId, runId), eq(workflowSnapshot.organizationId, organizationId)))
        .orderBy(desc(workflowSnapshot.createdAt))
        .limit(1);

      return row ? mapRowToSnapshot(row) : null;
    },

    /** 持久化快照 */
    async createSnapshot(snapshot: DAGSnapshot): Promise<void> {
      await db.insert(workflowSnapshot).values({
        snapshotId: snapshot.snapshot_id,
        runId: snapshot.run_id,
        lastEventId: snapshot.last_event_id,
        timestamp: new Date(snapshot.timestamp),
        nodeStates: snapshot.node_states,
        dagStatus: snapshot.dag_status,
        organizationId,
      });
    },

    // ---------- 节点输出 ----------

    /** 获取指定节点的输出，不存在返回 null */
    async getOutput(runId: string, nodeId: string): Promise<NodeOutput | null> {
      const [row] = await db
        .select()
        .from(workflowNodeOutput)
        .where(
          and(
            eq(workflowNodeOutput.runId, runId),
            eq(workflowNodeOutput.nodeId, nodeId),
            eq(workflowNodeOutput.organizationId, organizationId),
          ),
        )
        .limit(1);

      if (!row) return null;

      return {
        stdout: row.stdout,
        json: row.json ?? undefined,
        exit_code: row.exitCode,
        size: row.size ?? undefined,
        ref: row.ref ?? undefined,
      };
    },

    /** 写入节点输出 */
    async setOutput(runId: string, nodeId: string, output: NodeOutput): Promise<void> {
      await db
        .insert(workflowNodeOutput)
        .values({
          runId,
          nodeId,
          stdout: output.stdout,
          json: output.json ?? null,
          exitCode: output.exit_code,
          size: output.size ?? null,
          ref: output.ref ?? null,
          organizationId,
        })
        .onConflictDoUpdate({
          target: [workflowNodeOutput.runId, workflowNodeOutput.nodeId],
          set: {
            stdout: output.stdout,
            json: output.json ?? null,
            exitCode: output.exit_code,
            size: output.size ?? null,
            ref: output.ref ?? null,
          },
        });
    },

    // ---------- 运行查询 ----------

    /** 列出所有运行摘要，可按 projectId 过滤。从快照表聚合 */
    async listRuns(projectId?: string): Promise<RunSummary[]> {
      // 使用 DISTINCT ON 获取每个 runId 的最新快照
      const latestSnapshots = db
        .selectDistinctOn([workflowSnapshot.runId])
        .from(workflowSnapshot)
        .where(eq(workflowSnapshot.organizationId, organizationId))
        .orderBy(workflowSnapshot.runId, desc(workflowSnapshot.createdAt))
        .as("latest");

      let rows: (typeof workflowSnapshot.$inferSelect)[];
      if (projectId) {
        // 需要关联 event 表获取 projectId，但 event 表不一定有对应记录
        // 简单方案：通过 event 表的 projectId 过滤 runId
        const projectRunIds = db
          .selectDistinct({ runId: workflowEvent.runId })
          .from(workflowEvent)
          .where(and(eq(workflowEvent.organizationId, organizationId), eq(workflowEvent.projectId, projectId)));

        rows = await db
          .select()
          .from(latestSnapshots)
          .where(sql`${latestSnapshots.runId} in (${sql`select run_id from ${projectRunIds}`})`)
          .orderBy(desc(latestSnapshots.createdAt));
      } else {
        rows = await db.select().from(latestSnapshots).orderBy(desc(latestSnapshots.createdAt));
      }

      return rows.map(mapSnapshotToRunSummary);
    },

    /** 获取运行状态，从最新快照读取 dagStatus */
    async getRunStatus(runId: string): Promise<DAGStatus | null> {
      const snapshot = await this.getLatestSnapshot(runId);
      return snapshot ? snapshot.dag_status : null;
    },

    // ---------- 原子操作 ----------

    /**
     * 原子写入节点完成结果。
     * output + snapshot + event 在同一事务中写入，保证一致性。
     */
    async atomicNodeComplete(opts: { output: NodeOutput; snapshot: DAGSnapshot; event: DAGEvent }): Promise<void> {
      await db.transaction(async (tx) => {
        // 写入节点输出（upsert）
        await tx
          .insert(workflowNodeOutput)
          .values({
            runId: opts.snapshot.run_id,
            nodeId: opts.event.node_id ?? "",
            stdout: opts.output.stdout,
            json: opts.output.json ?? null,
            exitCode: opts.output.exit_code,
            size: opts.output.size ?? null,
            ref: opts.output.ref ?? null,
            organizationId,
          })
          .onConflictDoUpdate({
            target: [workflowNodeOutput.runId, workflowNodeOutput.nodeId],
            set: {
              stdout: opts.output.stdout,
              json: opts.output.json ?? null,
              exitCode: opts.output.exit_code,
              size: opts.output.size ?? null,
              ref: opts.output.ref ?? null,
            },
          });

        // 写入快照
        await tx.insert(workflowSnapshot).values({
          snapshotId: opts.snapshot.snapshot_id,
          runId: opts.snapshot.run_id,
          lastEventId: opts.snapshot.last_event_id,
          timestamp: new Date(opts.snapshot.timestamp),
          nodeStates: opts.snapshot.node_states,
          dagStatus: opts.snapshot.dag_status,
          organizationId,
        });

        // 写入事件
        await tx.insert(workflowEvent).values({
          eventId: opts.event.event_id,
          runId: opts.event.run_id,
          projectId: opts.event.project_id,
          nodeId: opts.event.node_id,
          timestamp: new Date(opts.event.timestamp),
          type: opts.event.type,
          nodeType: opts.event.node_type,
          metadata: opts.event.metadata ?? null,
          organizationId,
        });
      });
    },

    // ---------- 清理 ----------

    /** 删除指定运行的所有关联数据（事件、快照、节点输出），在事务中执行 */
    async deleteRun(runId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .delete(workflowEvent)
          .where(and(eq(workflowEvent.runId, runId), eq(workflowEvent.organizationId, organizationId)));
        await tx
          .delete(workflowSnapshot)
          .where(and(eq(workflowSnapshot.runId, runId), eq(workflowSnapshot.organizationId, organizationId)));
        await tx
          .delete(workflowNodeOutput)
          .where(and(eq(workflowNodeOutput.runId, runId), eq(workflowNodeOutput.organizationId, organizationId)));
      });
    },
  };
}

// ────────────────────────────────────────────
// 行映射辅助函数
// ────────────────────────────────────────────

/** 将数据库行映射为 DAGEvent */
function mapRowToEvent(row: typeof workflowEvent.$inferSelect): DAGEvent {
  return {
    event_id: row.eventId,
    run_id: row.runId,
    project_id: row.projectId ?? undefined,
    node_id: row.nodeId ?? undefined,
    timestamp: row.timestamp.toISOString(),
    type: row.type as EventType,
    node_type: row.nodeType as NodeType | undefined,
    metadata: (row.metadata as Record<string, unknown>) ?? undefined,
  };
}

/** 将数据库行映射为 DAGSnapshot */
function mapRowToSnapshot(row: typeof workflowSnapshot.$inferSelect): DAGSnapshot {
  return {
    snapshot_id: row.snapshotId,
    run_id: row.runId,
    last_event_id: row.lastEventId,
    timestamp: row.timestamp.toISOString(),
    node_states: row.nodeStates as Record<
      string,
      { status: import("@mothership/workflow-engine").NodeStatus; exit_code?: number }
    >,
    dag_status: row.dagStatus as DAGStatus,
  };
}

/** 将快照行映射为 RunSummary */
function mapSnapshotToRunSummary(row: typeof workflowSnapshot.$inferSelect): RunSummary {
  const nodeStates = row.nodeStates as Record<string, { status: string }>;
  const nodes = Object.values(nodeStates);

  let completed = 0;
  let failed = 0;
  let running = 0;
  for (const n of nodes) {
    if (n.status === "COMPLETED") completed++;
    else if (n.status === "FAILED") failed++;
    else if (n.status === "RUNNING") running++;
  }

  const isTerminal = ["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(row.dagStatus);

  return {
    run_id: row.runId,
    workflow_id: row.workflowId ?? undefined,
    workflow_name: "",
    status: row.dagStatus as DAGStatus,
    started_at: row.timestamp.toISOString(),
    completed_at: isTerminal ? row.timestamp.toISOString() : undefined,
    node_summary: {
      total: nodes.length,
      completed,
      failed,
      running,
    },
  };
}
