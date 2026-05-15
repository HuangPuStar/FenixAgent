/** SessionWorker 仓储 — 内存 Map 存储，Worker 状态追踪 */
export interface SessionWorkerRecord {
  sessionId: string;
  workerStatus: string | null;
  externalMetadata: Record<string, unknown> | null;
  requiresActionDetails: Record<string, unknown> | null;
  lastHeartbeatAt: Date | null;
}

export interface ISessionWorkerRepo {
  get(sessionId: string): Promise<SessionWorkerRecord | undefined>;
  upsert(sessionId: string, patch: Partial<Omit<SessionWorkerRecord, "sessionId">>): Promise<SessionWorkerRecord>;
  reset(): void;
}

class InMemorySessionWorkerRepo implements ISessionWorkerRepo {
  private workers = new Map<string, SessionWorkerRecord>();

  async get(sessionId: string): Promise<SessionWorkerRecord | undefined> {
    return this.workers.get(sessionId);
  }

  async upsert(sessionId: string, patch: Partial<Omit<SessionWorkerRecord, "sessionId">>): Promise<SessionWorkerRecord> {
    let record = this.workers.get(sessionId);
    if (!record) {
      record = {
        sessionId,
        workerStatus: null,
        externalMetadata: null,
        requiresActionDetails: null,
        lastHeartbeatAt: null,
      };
      this.workers.set(sessionId, record);
    }
    Object.assign(record, patch);
    return record;
  }

  reset(): void {
    this.workers.clear();
  }
}

export const sessionWorkerRepo: ISessionWorkerRepo = new InMemorySessionWorkerRepo();
