/**
 * Workflow Definition API Client。
 *
 * 对接后端 POST /web/workflow-defs，通过 action 字段分发。
 */

// ── 类型定义 ──

export interface WorkflowDefItem {
  id: string;
  userId: string;
  teamId: string;
  name: string;
  description: string | null;
  latestVersion: number | null;
  storagePath: string | null;
  createdAt: string;
  updatedAt: string;
  draftYaml?: string | null;
}

export interface WorkflowVersionItem {
  id: string;
  workflowId: string;
  version: number;
  filePath: string;
  status: string;
  createdBy: string;
  createdAt: string;
}

export interface VersionYamlResponse {
  workflowId: string;
  version: number;
  yaml: string;
}

// ── API Helper ──

async function defFetch<T>(action: string, extra?: Record<string, unknown>): Promise<T> {
  const res = await fetch("/web/workflow-defs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, ...extra }),
  });

  const json = await res.json();

  if (!res.ok) {
    const errInfo = json.error ?? { message: res.statusText };
    throw new Error(errInfo.message ?? errInfo.type ?? `请求失败 (${res.status})`);
  }

  return json.success && json.data !== undefined ? (json.data as T) : (json as T);
}

// ── API Methods ──

export const workflowDefApi = {
  /** 创建工作流 */
  async create(name: string, description?: string): Promise<WorkflowDefItem> {
    return defFetch<WorkflowDefItem>("create", { name, description });
  },

  /** 保存草稿 */
  async save(workflowId: string, yaml: string): Promise<void> {
    await defFetch("save", { workflowId, yaml });
  },

  /** 发布版本 */
  async publish(workflowId: string): Promise<WorkflowVersionItem> {
    return defFetch<WorkflowVersionItem>("publish", { workflowId });
  },

  /** 列出工作流 */
  async list(): Promise<WorkflowDefItem[]> {
    return defFetch<WorkflowDefItem[]>("list");
  },

  /** 获取单个工作流（含草稿内容） */
  async get(workflowId: string): Promise<WorkflowDefItem> {
    return defFetch<WorkflowDefItem>("get", { workflowId });
  },

  /** 获取版本历史 */
  async getVersions(workflowId: string): Promise<WorkflowVersionItem[]> {
    return defFetch<WorkflowVersionItem[]>("getVersions", { workflowId });
  },

  /** 获取特定版本 YAML */
  async getVersion(workflowId: string, version: number): Promise<VersionYamlResponse> {
    return defFetch<VersionYamlResponse>("getVersion", { workflowId, version });
  },

  /** 设置 latest 指针（回滚） */
  async setLatest(workflowId: string, version: number): Promise<void> {
    await defFetch("setLatest", { workflowId, version });
  },

  /** 删除工作流 */
  async delete(workflowId: string): Promise<void> {
    await defFetch("delete", { workflowId });
  },

  /** 更新元数据 */
  async updateMeta(workflowId: string, data: { name?: string; description?: string }): Promise<WorkflowDefItem> {
    return defFetch<WorkflowDefItem>("updateMeta", { workflowId, ...data });
  },

  /** 扫描可恢复的工作流 ID */
  async recover(): Promise<string[]> {
    return defFetch<string[]>("recover");
  },

  /** 执行恢复 */
  async recoverApply(workflowIds: string[]): Promise<WorkflowDefItem[]> {
    return defFetch<WorkflowDefItem[]>("recoverApply", { workflowIds });
  },

  /** 恢复版本到草稿 */
  async restoreToDraft(workflowId: string, version: number): Promise<void> {
    await defFetch("restoreToDraft", { workflowId, version });
  },
};
