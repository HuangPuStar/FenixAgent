import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { machine } from "../db/schema";
import { AppError } from "../errors";
import { environmentRepo } from "../repositories";
import { findActiveSandboxInstance } from "../repositories/sandbox-instance-repository";
import { findReadableSandboxPoolById } from "../repositories/sandbox-pool-repository";
import { isFileWsConnected } from "../transport/file-ws-handler";
import { type FileOpOptions, sendFileOpAndWait } from "../transport/file-ws-requests";
import { getAgentConfigById, resolveAgentNode } from "./config/agent-config";
import type { AgentNode } from "./config/types";

type RemoteMachineResolutionInput = {
  agentNode: AgentNode | null;
  sandboxMachineId: string | null;
  sandboxSelected: boolean;
  defaultMachineId: string | null;
};

/** 根据运行节点配置选择文件操作使用的 Machine 身份。 */
export function selectRemoteMachineId(input: RemoteMachineResolutionInput): string | null {
  if (input.agentNode && "kind" in input.agentNode && input.agentNode.kind === "machine") {
    return input.agentNode.machineId;
  }
  if (input.sandboxSelected) return input.sandboxMachineId;
  return input.defaultMachineId;
}

// ── 远程 upload 单文件上限（字节）与 413 文案 ──
// 权威声明在 file-types.ts（REMOTE_UPLOAD_MAX_BYTES / REMOTE_UPLOAD_LIMIT_MESSAGE）；
// 此处独立声明以避免两服务模块互相导入成环（agent-file-service 已导入本模块函数），
// 修改上限或文案必须两处同步——fs-upload-limit.test.ts 断言锁定，漂移即测试失败。
const REMOTE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const REMOTE_UPLOAD_LIMIT_MESSAGE = "单文件上限 20MB（远程环境）；更大文件可通过本地环境上传或让 Agent 用工具拉取";

// ── 远程 zip 单帧上限与 413 文案（W16，§7.9）──
// 单帧过渡版：base64 帧受 W8a 32MB WS 载荷约束（20MB 原数据 ≈ 27MB 帧），超过 20MB
// 明确 413 + 建议选择子目录，不截断；分块回传（file_op_chunk，总包 ≤100MB）属二期。
const REMOTE_ZIP_MAX_BYTES = 20 * 1024 * 1024;
/** zip 超限的 413 用户可读文案（跨 plan 契约："建议选择子目录"），fs-zip-remote.test.ts 断言锁定 */
export const REMOTE_ZIP_LIMIT_MESSAGE = "目录打包后超过 20MB（远程环境），建议选择子目录后重试";

// zip 超时派生（§7.9：默认 60s 不够，按 60s + 总包/2MB/s 预算）。单帧过渡版发送时
// 总包未知，按 20MB 上限派生（60s + 10s = 70s）；分块二期首帧携带总大小后改按实际总包派生。
const REMOTE_ZIP_TIMEOUT_MS = 60_000 + (REMOTE_ZIP_MAX_BYTES / (2 * 1024 * 1024)) * 1000;

/**
 * 判断 environment 是否绑定了远程 machine（且 file-ws 已连接）。
 * 优先级：显式 Machine > Sandbox Instance Machine > 默认 Machine > null（本地）
 *
 * 三分语义（§2.4 machineId 配置校验，区分"配置错误"与"连接不可用"）：
 * - 无 machineId 配置 → 返回 null（调用方使用本地 FS）
 * - machineId 已配置但不存在于 DB machine 表 → 422 config_error（配置错误，
 *   message 提示去管理面检查；RCS_DEFAULT_MACHINE_ID 兜底机器由 core-bootstrap
 *   自动创建，存在性校验会通过）
 * - machineId 存在但 file-ws 未连接 → 503 file_service_unavailable（明确拒绝
 *   本地回退，避免"配置了远程机器，用户以为文件在远程，实际落在本地"的分裂场景）
 * - 连接正常 → 返回 machineId
 */
export async function getRemoteMachineId(envId: string): Promise<string | null> {
  const env = await environmentRepo.getById(envId);
  if (!env) return null;
  const agentCfg = env.agentConfigId ? await getAgentConfigById(env.agentConfigId) : null;
  const agentNode = agentCfg ? resolveAgentNode(agentCfg) : {};
  const explicitSandboxPoolId = agentNode?.kind === "sandbox" ? agentNode.sandboxPoolId : null;
  const useDefaultSandbox = agentNode?.kind !== "machine" && !explicitSandboxPoolId && config.sandboxEnabled;
  const sandboxPoolId = explicitSandboxPoolId ?? (useDefaultSandbox ? config.defaultSandboxPoolId : null);
  const sandboxSelected = Boolean(explicitSandboxPoolId || (useDefaultSandbox && sandboxPoolId));

  let sandboxMachineId: string | null = null;
  if (sandboxPoolId && env.userId) {
    const pool = await findReadableSandboxPoolById(sandboxPoolId, env.organizationId ?? env.userId);
    if (pool) {
      const instance = await findActiveSandboxInstance(pool.providerKey, pool.id, env.userId);
      sandboxMachineId = instance?.machineId ?? null;
    }
  }

  const machineId = selectRemoteMachineId({
    agentNode,
    sandboxMachineId,
    sandboxSelected,
    defaultMachineId: config.defaultMachineId ?? null,
  });

  // 没有配置 machine → 本地 FS
  if (!machineId) return null;

  // 存在性校验：machineId 不在 DB machine 表中 → 422（配置错误），
  // 与"存在但未连接"的 503 区分，避免三种根因都归 503 误导排障
  const rows = await db.select().from(machine).where(eq(machine.id, machineId)).limit(1);
  if (rows.length === 0) {
    throw new AppError(`远程机器配置不存在 (machine: ${machineId})，请到管理面检查机器配置`, "config_error", 422);
  }

  // 配了 machine 但 file-ws 未连 → 主动报错，不透传回退
  if (!isFileWsConnected(machineId)) {
    throw new AppError(
      `远程机器文件服务不可用 (machine: ${machineId})，请检查远程机器是否在线`,
      "file_service_unavailable",
      503,
    );
  }

  return machineId;
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

/** 写入远程文本文件（options.opId 幂等键透传，§7.2：消费者重试复用同值，机器端 10 分钟内去重） */
export async function remoteWriteFile(
  machineId: string,
  envId: string,
  filePath: string,
  content: string,
  options?: FileOpOptions,
): Promise<{ name: string; path: string; size: number }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(
    machineId,
    "write",
    {
      path: filePath,
      content,
      environmentId: envId,
    },
    undefined,
    options,
  );
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { name: string; path: string; size: number };
}

/**
 * 上传文件到远程机器（base64 编码）。
 * W8b（P1-11b）：发送前逐文件检查单文件上限（20MB）——20MB 原文件的 base64 帧约
 * 27MB，仍低于 W8a 的 32MB WS 载荷上限，若不提前拦截会构造出 ~27MB 大帧后才被
 * 兜底拒绝；从 base64 精确反推原始字节数（含 padding，恰好 20MB 允许）。
 */
export async function remoteUploadFiles(
  machineId: string,
  envId: string,
  dir: string,
  files: Array<{ name: string; content: string; relativePath: string }>,
  options?: FileOpOptions,
): Promise<{ files: Array<{ name: string; path: string; size: number }> }> {
  assertFileWsAvailable(machineId);
  for (const file of files) {
    const padding = file.content.endsWith("==") ? 2 : file.content.endsWith("=") ? 1 : 0;
    const originalBytes = Math.floor((file.content.length * 3) / 4) - padding;
    if (originalBytes > REMOTE_UPLOAD_MAX_BYTES) {
      throw new AppError(REMOTE_UPLOAD_LIMIT_MESSAGE, "payload_too_large", 413);
    }
  }
  const result = await sendFileOpAndWait(
    machineId,
    "upload",
    {
      dir,
      files,
      environmentId: envId,
    },
    120_000,
    options,
  );
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { files: Array<{ name: string; path: string; size: number }> };
}

/** 删除远程文件（options.opId 幂等键透传，§7.2） */
export async function remoteDeleteFile(
  machineId: string,
  envId: string,
  filePath: string,
  options?: FileOpOptions,
): Promise<{ ok: boolean }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(
    machineId,
    "delete",
    { path: filePath, environmentId: envId },
    undefined,
    options,
  );
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { ok: boolean };
}

/** 重命名远程文件/目录（options.opId 幂等键透传，§7.2） */
export async function remoteRename(
  machineId: string,
  envId: string,
  oldPath: string,
  newPath: string,
  options?: FileOpOptions,
): Promise<{ oldPath: string; newPath: string }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(
    machineId,
    "rename",
    {
      oldPath,
      newPath,
      environmentId: envId,
    },
    undefined,
    options,
  );
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { oldPath: string; newPath: string };
}

/** 创建远程目录（options.opId 幂等键透传，§7.2） */
export async function remoteMkdir(
  machineId: string,
  envId: string,
  dirPath: string,
  options?: FileOpOptions,
): Promise<{ path: string }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(
    machineId,
    "mkdir",
    { path: dirPath, environmentId: envId },
    undefined,
    options,
  );
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as { path: string };
}

/** 递归列出远程 workspace 下所有路径（含修改时间和遍历错误） */
export async function remoteTree(
  machineId: string,
  envId: string,
): Promise<{ paths: string[]; mtimes?: Record<string, number>; errors?: { path: string; message: string }[] }> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "tree", { environmentId: envId });
  if (result.status === "error") throw new Error(result.error as string);
  return result.data as {
    paths: string[];
    mtimes?: Record<string, number>;
    errors?: { path: string; message: string }[];
  };
}

/**
 * 远程目录打包 zip（file_op "zip"，W16，§7.9）。
 * 单帧回传：机器端打包完成后一次性以 base64 返回（受 W8a 32MB WS 载荷约束 →
 * zip ≤ ~20MB）；超过 20MB 抛 413 payload_too_large + "建议选择子目录"，不截断。
 * 机器端 zip 操作未上线（外部依赖）时返回 status:"error"，由调用方映射 503 明确错误。
 * @returns base64 编码的 zip 单帧
 */
export async function remoteZip(machineId: string, envId: string, path: string): Promise<string> {
  assertFileWsAvailable(machineId);
  const result = await sendFileOpAndWait(machineId, "zip", { path, environmentId: envId }, REMOTE_ZIP_TIMEOUT_MS);
  if (result.status === "error") throw new Error(result.error as string);
  const data = result.data as string;
  // 从 base64 精确反推原始字节数（含 padding，与 remoteUploadFiles 同法）：
  // >20MB 明确拒绝，不得截断回传部分 zip（不完整包对消费者比失败更糟）
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const originalBytes = Math.floor((data.length * 3) / 4) - padding;
  if (originalBytes > REMOTE_ZIP_MAX_BYTES) {
    throw new AppError(REMOTE_ZIP_LIMIT_MESSAGE, "payload_too_large", 413);
  }
  return data;
}
