import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REGISTRY_FILENAME = ".workspace-registry.json";

/** environmentId → absolute workspace path */
const cache = new Map<string, string>();

let registryPath: string | null = null;

/**
 * 初始化 registry：设置文件路径并从磁盘加载已有映射。
 */
export async function initRegistry(workspaceRoot: string): Promise<void> {
  registryPath = join(workspaceRoot, REGISTRY_FILENAME);
  try {
    const raw = await readFile(registryPath, "utf-8");
    const data = JSON.parse(raw) as Record<string, string>;
    for (const [envId, ws] of Object.entries(data)) {
      cache.set(envId, ws);
    }
    console.log(`[workspace-registry] loaded ${cache.size} mapping(s) from ${registryPath}`);
  } catch {
    console.log("[workspace-registry] no existing registry, starting fresh");
  }
}

/** 注册映射，同时持久化到磁盘 */
export async function registerWorkspace(environmentId: string, workspace: string): Promise<void> {
  cache.set(environmentId, workspace);
  await flushToDisk();
  console.log(`[workspace-registry] registered: ${environmentId} → ${workspace}`);
}

/** 注销映射，同时持久化 */
export async function unregisterWorkspace(environmentId: string): Promise<void> {
  cache.delete(environmentId);
  await flushToDisk();
  console.log(`[workspace-registry] unregistered: ${environmentId}`);
}

/** 同步查询（用于 handleFileOp） */
export function getWorkspaceSync(environmentId: string): string | null {
  return cache.get(environmentId) ?? null;
}

async function flushToDisk(): Promise<void> {
  if (!registryPath) return;
  const data: Record<string, string> = {};
  for (const [k, v] of cache) {
    data[k] = v;
  }
  await writeFile(registryPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}
