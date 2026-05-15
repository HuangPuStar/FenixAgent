import { v4 as uuid } from "uuid";

/** WorkItem 仓储 — 内存 Map 存储，任务调度队列 */
export interface WorkItemRecord {
  id: string;
  environmentId: string;
  sessionId: string;
  secret: string;
  state: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IWorkItemRepo {
  create(params: { environmentId: string; sessionId: string; secret: string }): Promise<WorkItemRecord>;
  getById(id: string): Promise<WorkItemRecord | undefined>;
  getPendingByEnvironment(environmentId: string): Promise<WorkItemRecord | undefined>;
  update(id: string, patch: Partial<Pick<WorkItemRecord, "state">>): Promise<boolean>;
  reset(): void;
}

class InMemoryWorkItemRepo implements IWorkItemRepo {
  private items = new Map<string, WorkItemRecord>();

  async create(params: { environmentId: string; sessionId: string; secret: string }): Promise<WorkItemRecord> {
    const id = `work_${uuid().replace(/-/g, "")}`;
    const now = new Date();
    const record: WorkItemRecord = {
      id,
      environmentId: params.environmentId,
      sessionId: params.sessionId,
      secret: params.secret,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(id, record);
    return record;
  }

  async getById(id: string): Promise<WorkItemRecord | undefined> {
    return this.items.get(id);
  }

  async getPendingByEnvironment(environmentId: string): Promise<WorkItemRecord | undefined> {
    for (const item of this.items.values()) {
      if (item.environmentId === environmentId && item.state === "pending") {
        return item;
      }
    }
    return undefined;
  }

  async update(id: string, patch: Partial<Pick<WorkItemRecord, "state">>): Promise<boolean> {
    const item = this.items.get(id);
    if (!item) return false;
    Object.assign(item, patch, { updatedAt: new Date() });
    return true;
  }

  reset(): void {
    this.items.clear();
  }
}

export const workItemRepo: IWorkItemRepo = new InMemoryWorkItemRepo();
