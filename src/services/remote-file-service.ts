import { environmentRepo } from "../repositories";
import { isFileWsConnected, sendFileOpAndWait } from "../transport/file-ws-handler";
import { getAgentConfigById } from "./config/agent-config";

/**
 * 判断 environment 是否绑定了远程 machine。
 * 返回 machineId 或 null。
 */
export async function getRemoteMachineId(envId: string): Promise<string | null> {
  const env = await environmentRepo.getById(envId);
  if (!env?.agentConfigId) return null;
  const agentCfg = await getAgentConfigById(env.agentConfigId);
  return agentCfg?.machineId ?? null;
}

/**
 * 检查远程 machine 的 file-ws 是否可用。
 * 如果不可用，抛出带有明确提示的 Error。
 */
function assertFileWsAvailable(machineId: string): void {
  if (!isFileWsConnected(machineId)) {
    throw new Error(`远程机器文件服务不可用 (machine: ${machineId})，请检查远程机器是否在线`);
  }
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: number;
}

/** 列出远程目录内容 */
export async function remoteListDir(machineId: string, envId: string, queryPath: string): Promise<RemoteFileEntry[]> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "list", { path: queryPath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return (result.data as { entries: RemoteFileEntry[] }).entries;
}

/** 获取远程文件 stat 信息 */
export async function remoteStat(
  machineId: string,
  envId: string,
  filePath: string,
): Promise<{ size: number; isDirectory: boolean; modifiedAt: number }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "stat", { path: filePath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { size: number; isDirectory: boolean; modifiedAt: number };
}

/** 读取远程文本文件 */
export async function remoteReadFile(
  machineId: string,
  envId: string,
  filePath: string,
): Promise<{ name: string; path: string; content: string; size: number; encoding: string }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "read", { path: filePath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { name: string; path: string; content: string; size: number; encoding: string };
}

/** 读取远程二进制文件（base64） */
export async function remoteReadBinaryFile(
  machineId: string,
  envId: string,
  filePath: string,
): Promise<{ name: string; path: string; data: string; size: number; mimeType: string }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "read_binary", { path: filePath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { name: string; path: string; data: string; size: number; mimeType: string };
}

/** 写入远程文本文件 */
export async function remoteWriteFile(
  machineId: string,
  envId: string,
  filePath: string,
  content: string,
): Promise<{ name: string; path: string; size: number }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "write", {
    path: filePath,
    content,
    environmentId: envId,
  });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { name: string; path: string; size: number };
}

/** 上传文件到远程机器（base64 编码） */
export async function remoteUploadFiles(
  machineId: string,
  envId: string,
  dir: string,
  files: Array<{ name: string; content: string; relativePath: string }>,
): Promise<{ files: Array<{ name: string; path: string; size: number }> }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(
    machineId,
    "upload",
    {
      dir,
      files,
      environmentId: envId,
    },
    120_000,
  );
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { files: Array<{ name: string; path: string; size: number }> };
}

/** 删除远程文件 */
export async function remoteDeleteFile(machineId: string, envId: string, filePath: string): Promise<{ ok: boolean }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "delete", { path: filePath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { ok: boolean };
}

/** 重命名远程文件/目录 */
export async function remoteRename(
  machineId: string,
  envId: string,
  oldPath: string,
  newPath: string,
): Promise<{ oldPath: string; newPath: string }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "rename", {
    oldPath,
    newPath,
    environmentId: envId,
  });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { oldPath: string; newPath: string };
}

/** 创建远程目录 */
export async function remoteMkdir(machineId: string, envId: string, dirPath: string): Promise<{ path: string }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "mkdir", { path: dirPath, environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { path: string };
}

/** 递归列出远程 user/ 下所有路径 */
export async function remoteTree(machineId: string, envId: string): Promise<string[]> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "tree", { environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return (result.data as { paths: string[] }).paths;
}
