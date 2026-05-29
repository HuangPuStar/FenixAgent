/**
 * Workflow Boards API Client。
 *
 * 对接后端 POST /web/workflow-boards，通过 action 字段分发。
 */

// ── 类型 ──

export interface WorkflowBoard {
  id: string;
  organizationId: string;
  name: string;
  userId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── helpers ──

async function postAction(action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch("/web/workflow-boards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, ...extra }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Unknown error");
  return json.data;
}

// ── API ──

export const workflowBoardsApi = {
  async list(): Promise<WorkflowBoard[]> {
    const data = await postAction("list");
    return Array.isArray(data) ? data : [];
  },

  async get(boardId: string): Promise<WorkflowBoard> {
    return postAction("get", { boardId }) as Promise<WorkflowBoard>;
  },

  async create(name: string): Promise<WorkflowBoard> {
    return postAction("create", { name }) as Promise<WorkflowBoard>;
  },

  async update(boardId: string, name: string): Promise<void> {
    await postAction("update", { boardId, name });
  },

  async delete(boardId: string): Promise<void> {
    await postAction("delete", { boardId });
  },
};
