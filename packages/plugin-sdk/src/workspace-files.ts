import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentLaunchSpec, WorkspaceFile } from "./agent-launch-spec";

/** 文件路径在统一边界校验，四个引擎不各自解释或拼接托管路径。 */
function resolveFilePath(workspace: string, path: string): string {
  const target = resolve(workspace, path);
  const local = relative(workspace, target);
  if (!isAbsolute(workspace) || isAbsolute(path) || !local || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error("工作区托管文件路径非法");
  }
  return target;
}

/**
 * 将传输 DTO 转成执行位置的独立快照。本地用 resolveWorkspacePath 的结果；machine 用实际 workspace
 * 重定位（两端根目录可能不同）。Hindsight 只保留定位信号，拒绝旧配置 env 从 extraEnv 混入。
 */
export function bindWorkspaceFiles(spec: AgentLaunchSpec, workspace: string): AgentLaunchSpec {
  const env = Object.fromEntries(Object.entries(spec.env ?? {}).filter(([key]) => !key.startsWith("HINDSIGHT_")));
  const workspaceFiles = spec.workspaceFiles?.map((file) => {
    const path = resolveFilePath(workspace, file.path);
    if (file.envVar) env[file.envVar] = path;
    return {
      ...file,
      content: {
        ...structuredClone(file.content),
        managed: { writer: "FenixAgent", workspaceRoot: workspace, writtenAt: new Date().toISOString() },
      },
    };
  });
  return { ...spec, env, ...(workspaceFiles ? { workspaceFiles } : {}) };
}

/** 每次 prepare 原子全量替换，权限固定 0600；拒绝目录符号链接，避免凭据落到工作区之外。 */
export async function writeWorkspaceFiles(workspace: string, files: WorkspaceFile[] = []): Promise<void> {
  for (const file of files) {
    const target = resolveFilePath(workspace, file.path);
    const directory = dirname(target);
    let current = workspace;
    for (const segment of ["", ...relative(workspace, directory).split(sep).filter(Boolean)]) {
      current = join(current, segment);
      await mkdir(current, { recursive: true });
      if ((await lstat(current)).isSymbolicLink()) throw new Error("工作区托管目录不能是符号链接");
    }
    const temporary = join(directory, `.managed-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(file.content, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
