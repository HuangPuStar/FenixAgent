// file-backends.ts — AgentFileService 的执行后端层（§2.3，P1-7a 拆分）
//
// 自 agent-file-service.ts 拆出的执行侧逻辑（保持门面单文件 ≤500 行，CLAUDE.md）。
// 职责边界：
// - BackEnd 统一执行接口（§2.3）与能力上限显式声明（§2.4 能力不对称条款）；
// - LocalBackend：包装 workspace-fs（opId/ifMatch 为契约占位，W12b 启用）；
// - RemoteBackend：包装 remote-file-service（machineId 由门面路由决策注入）；
// - If-Match 版本比对（etagEquals / assertVersionMatch，W12b，§4.4）：仅被两个
//   后端调用，随后端迁入本文件（避免与门面 agent-file-service 互相导入成环）；
// - resolveExecutionBackend：BackEnd 路由决策（§3 回退链，实时判定不缓存）。
//
// 依赖方向：门面 → 本文件 → file-types / workspace-fs / remote-file-service。

import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { NotFoundError, ValidationError } from "../errors";
import type { FileOpOptions } from "../transport/file-ws-requests";
import { type FileChangeKind, publishFileChanged } from "./file-event-limiter";
import { normalizeUploadRelativePath } from "./file-path-validator";
import {
  FileServiceError,
  type FileWriteOptions,
  LOCAL_UPLOAD_MAX_BYTES,
  REMOTE_UPLOAD_MAX_BYTES,
  type ReadMode,
  type ReadResult,
  type StatResult,
  type TreeResult,
  type UploadFileInput,
  type UploadResult,
  type WriteResult,
} from "./file-types";
import {
  getRemoteMachineId,
  remoteDeleteFile,
  remoteListDir,
  remoteMkdir,
  remoteReadBinaryFile,
  remoteReadFile,
  remoteRename,
  remoteStat,
  remoteTree,
  remoteUploadFiles,
  remoteWriteFile,
  remoteZip,
} from "./remote-file-service";
import {
  computeReadFingerprint,
  createFileStream,
  deleteFile,
  deleteNode,
  type FileEntry,
  getMimeType,
  isTextExtension,
  isTextFile,
  listDirectory,
  listPathsRecursive,
  mkdirp,
  readFileContent,
  renamePath,
  resolveWorkspacePath,
  writeFileContent,
} from "./workspace-fs";

// ── If-Match 条件写（W12b，§4.4 并发写）────────────────────────

/** HTTP If-Match 单值弱比较：剥离 W/ 前缀与引号后按字符串相等判定（与读侧
 *  If-None-Match 的 etagMatches 同规约），保证"读到的 ETag 能原样写回比对"。 */
function etagEquals(ifMatch: string, etag: string): boolean {
  const normalize = (v: string) => v.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  return normalize(ifMatch) === normalize(etag);
}

/** If-Match 版本比对（§4.4）：当前版本（size+mtimeMs 派生 ETag，与读侧 read 指纹
 *  computeReadFingerprint 同源同规则）与消费者读取时携带的 ETag 不一致 → 409
 *  version_conflict + 当前版本回显（覆盖可感知性：消费者据此提示"文件已被修改"）。
 *  只保护"消费者-消费者"读改写——Agent 工具写入不走 HTTP、无 ETag，不参与比对
 *  （文档边界 §4.4）；mtime 缺失（远程弱指纹）时退化为 size-only 比对。 */
function assertVersionMatch(
  ifMatch: string | undefined,
  displayPath: string,
  size: number,
  mtimeMs: number | undefined,
): void {
  if (ifMatch === undefined) return;
  // HTTP If-Match 通配 `*`：表示"资源必须存在"，当前 stat 已证明存在 → 放行
  if (ifMatch.trim() === "*") return;
  const currentEtag = computeReadFingerprint(size, mtimeMs);
  if (!etagEquals(ifMatch, currentEtag)) {
    throw new FileServiceError(`文件已被修改 (${displayPath})，请刷新后重试`, "version_conflict", 409, {
      etag: currentEtag,
      mtimeMs: mtimeMs ?? 0,
      size,
    });
  }
}

// ── BackEnd 统一执行接口（§2.3）─────────────────────────────────

export interface BackEnd {
  /** 能力上限显式声明（§2.4 能力不对称条款）；W8b 实施检查 */
  readonly uploadMaxBytes: number;
  tree(envId: string, path?: string): Promise<TreeResult>;
  list(envId: string, path: string): Promise<FileEntry[]>;
  read(envId: string, path: string, mode: ReadMode): Promise<ReadResult>;
  write(envId: string, path: string, content: string, options?: FileWriteOptions): Promise<WriteResult>;
  upload(envId: string, dir: string, files: UploadFileInput[], options?: FileWriteOptions): Promise<UploadResult>;
  delete(envId: string, path: string, options?: FileWriteOptions): Promise<void>;
  mkdir(envId: string, path: string, options?: FileWriteOptions): Promise<void>;
  rename(envId: string, oldPath: string, newPath: string, options?: FileWriteOptions): Promise<void>;
  stat(envId: string, path: string): Promise<StatResult>;
  downloadZip(envId: string, path: string): Promise<NodeJS.ReadableStream>;
}

/** 本地实现：包装 workspace-fs（opId/ifMatch 为契约占位，W12b 启用） */
class LocalBackend implements BackEnd {
  readonly uploadMaxBytes = LOCAL_UPLOAD_MAX_BYTES;

  private async resolve(envId: string, path: string) {
    const resolved = await resolveWorkspacePath(envId, path);
    if (!resolved) throw new NotFoundError("环境不存在或路径越界");
    return resolved;
  }

  private async statOr404(filePath: string, message: string) {
    try {
      return await stat(filePath);
    } catch {
      throw new NotFoundError(message);
    }
  }

  /** 本地 If-Match 比对：stat 目标派生当前 ETag 后比对。目标不存在视为不匹配
   *  （HTTP If-Match 语义：资源缺失即失败——消费者"读→保存"闭环中文件被删属冲突），
   *  与不带 If-Match 时的 404 语义区分：只有显式条件写才升级为 409。 */
  private async assertLocalIfMatch(absPath: string, displayPath: string, ifMatch: string | undefined): Promise<void> {
    if (ifMatch === undefined) return;
    let info: Stats;
    try {
      info = await stat(absPath);
    } catch {
      throw new FileServiceError(`文件已不存在 (${displayPath})，请刷新后重试`, "version_conflict", 409);
    }
    assertVersionMatch(ifMatch, displayPath, info.size, info.mtimeMs);
  }

  async tree(envId: string): Promise<TreeResult> {
    const { workspaceDir } = await this.resolve(envId, ".");
    const { entries, errors } = await listPathsRecursive(workspaceDir);
    const mtimes: Record<string, number> = {};
    for (const e of entries) if (e.mtime > 0) mtimes[e.path] = e.mtime;
    return { paths: entries.map((e) => e.path), mtimes, errors: errors.length > 0 ? errors : undefined };
  }
  async list(envId: string, path: string): Promise<FileEntry[]> {
    const resolved = await this.resolve(envId, path);
    const info = await stat(resolved.resolved);
    if (!info.isDirectory()) throw new ValidationError("目标不是目录，请使用 read 接口");
    return listDirectory(resolved.resolved, resolved.userDir, resolved.workspaceDir);
  }

  async read(envId: string, path: string, mode: ReadMode): Promise<ReadResult> {
    const resolved = await this.resolve(envId, path);
    const info = await this.statOr404(resolved.resolved, "文件不存在");
    if (info.isDirectory()) throw new ValidationError("目标是目录，请使用 list 接口");
    const lastDot = path.lastIndexOf(".");
    const lastSlash = path.lastIndexOf("/");
    const ext = lastDot > lastSlash ? path.substring(lastDot) : "";
    const name = path.substring(lastSlash + 1);
    // 本地二进制保持流式（大文件零内存占用，与现状 fs.ts 一致）
    const binary = (): ReadResult => ({
      type: "binary",
      name,
      path: resolved.displayPath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      mimeType: getMimeType(ext),
      stream: createFileStream(resolved.resolved),
    });
    if (mode === "binary") return binary();
    // text/auto 共用同一文本探测；差异只在探测失败的分支（§7.8）：
    // text → 明确错误（不再静默回退二进制下载）；auto → 回退 binary
    const textFile = isTextExtension(ext) || (!ext && (await isTextFile(resolved.resolved)));
    if (!textFile) {
      if (mode === "text") {
        // 400：契约错误码表无"内容不可预览"类型（415 不在 §2.4 表），
        // 取 400 validation_error 作为客户端可处理的通用拒绝
        throw new FileServiceError("该文件不是文本文件，暂不支持预览", "validation_error", 400);
      }
      return binary();
    }
    const { content, size } = await readFileContent(resolved.resolved);
    return { type: "text", name, path: resolved.displayPath, content, size, encoding: "utf-8", mtimeMs: info.mtimeMs };
  }

  /**
   * 本地写操作成功后发布变更事件（W7，§4.3/§7.5）：与机器端事件走同一限频合并器
   * （不得跳过，D20 本地路径兜底）。source/actorId 取自写选项（门面从认证上下文注入）；
   * 远程路径不在此发布——机器端执行成功后自行推送 file_changed。
   */
  private publishLocal(
    envId: string,
    kind: FileChangeKind,
    path: string,
    options?: FileWriteOptions,
    to?: string,
  ): void {
    const change: {
      path: string;
      kind: FileChangeKind;
      source: "user" | "agent" | "api";
      actorId?: string;
      to?: string;
    } = {
      path,
      kind,
      source: options?.source ?? "user",
    };
    if (options?.actorId) change.actorId = options.actorId;
    if (to) change.to = to;
    publishFileChanged(envId, change);
  }

  async write(envId: string, path: string, content: string, options?: FileWriteOptions): Promise<WriteResult> {
    const resolved = await this.resolve(envId, path);
    await this.assertLocalIfMatch(resolved.resolved, path, options?.ifMatch);
    await writeFileContent(resolved.resolved, content);
    const name = path.substring(path.lastIndexOf("/") + 1);
    this.publishLocal(envId, "write", path, options);
    return { name, path: resolved.displayPath, size: Buffer.byteLength(content) };
  }
  async upload(
    envId: string,
    dir: string,
    files: UploadFileInput[],
    options?: FileWriteOptions,
  ): Promise<UploadResult> {
    const { resolved } = await this.resolve(envId, dir);
    // 目标目录条件写比对：目录被删/被改（mtime 变）→ 409；新建目录不应带 If-Match
    await this.assertLocalIfMatch(resolved, dir, options?.ifMatch);
    await mkdirp(resolved);
    const uploaded: UploadResult["files"] = [];
    for (const file of files) {
      // relativePath 已在门面统一校验；此处只取「已规范化」或「回退 file.name」
      const relPath = normalizeUploadRelativePath(file.relativePath) || file.name;
      const destPath = join(resolved, relPath);
      await mkdirp(dirname(destPath));
      await writeFile(destPath, file.content);
      const displayPath = dir ? `${dir}/${relPath}` : relPath;
      uploaded.push({ name: file.name, path: displayPath, size: file.content.byteLength });
      this.publishLocal(envId, "upload", displayPath, options);
    }
    return { files: uploaded };
  }
  async delete(envId: string, path: string, options?: FileWriteOptions): Promise<void> {
    const resolved = await this.resolve(envId, path);
    await this.assertLocalIfMatch(resolved.resolved, path, options?.ifMatch);
    const info = await this.statOr404(resolved.resolved, "文件不存在");
    if (info.isDirectory()) await deleteNode(resolved.resolved);
    else await deleteFile(resolved.resolved);
    this.publishLocal(envId, "delete", path, options);
  }
  async mkdir(envId: string, path: string, options?: FileWriteOptions): Promise<void> {
    const resolved = await this.resolve(envId, path);
    await this.assertLocalIfMatch(resolved.resolved, path, options?.ifMatch);
    await mkdirp(resolved.resolved);
    this.publishLocal(envId, "mkdir", path, options);
  }
  async rename(envId: string, oldPath: string, newPath: string, options?: FileWriteOptions): Promise<void> {
    const oldResolved = await this.resolve(envId, oldPath);
    await this.assertLocalIfMatch(oldResolved.resolved, oldPath, options?.ifMatch);
    await this.statOr404(oldResolved.resolved, "源路径不存在");
    const newResolved = await this.resolve(envId, newPath);
    await renamePath(oldResolved.resolved, newResolved.resolved);
    this.publishLocal(envId, "rename", oldPath, options, newPath);
  }
  async stat(envId: string, path: string): Promise<StatResult> {
    const resolved = await this.resolve(envId, path);
    const info = await this.statOr404(resolved.resolved, "文件不存在");
    return {
      size: info.size,
      isDirectory: info.isDirectory(),
      modifiedAt: info.mtimeMs,
      isText: info.isFile() ? await isTextFile(resolved.resolved) : undefined,
    };
  }
  async downloadZip(envId: string, path: string): Promise<NodeJS.ReadableStream> {
    const resolved = await this.resolve(envId, path);
    const info = await this.statOr404(resolved.resolved, "路径不存在");
    if (!info.isDirectory()) throw new ValidationError("目标不是目录");
    const zipProcess = spawn("zip", ["-r", "-q", "-", "."], {
      cwd: resolved.resolved,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return zipProcess.stdout;
  }
}

/** 远程实现：包装 remote-file-service（machineId 由门面路由决策注入） */
class RemoteBackend implements BackEnd {
  readonly uploadMaxBytes = REMOTE_UPLOAD_MAX_BYTES;
  constructor(private machineId: string) {}

  /** options → file_op 帧参数（opId/actorId/source 透传，§7.2 / P2-18）；ifMatch 不
   *  进帧（机器端执行点无版本概念），比对在服务端经 remoteStat 完成 */
  private remoteOptions(options?: FileWriteOptions): FileOpOptions | undefined {
    const { opId, actorId, source } = options ?? {};
    if (!opId && !actorId && !source) return;
    return { ...(opId ? { opId } : {}), ...(actorId ? { actorId } : {}), ...(source ? { source } : {}) };
  }

  /** 远程 If-Match 比对：remoteStat（有 modifiedAt）派生当前 ETag 后比对。stat 失败
   *  保持原始错误传播（断连/机器端错误 → 503 语义，不吞错）；远程 stat 无
   *  not-found 语义（机器端错误码统一 error），目标缺失与服务不可用无法区分，
   *  故仅 stat 成功时才有版本冲突判定（诚实边界，§4.4）。 */
  private async assertRemoteIfMatch(envId: string, path: string, ifMatch: string | undefined): Promise<void> {
    if (ifMatch === undefined) return;
    const r = await remoteStat(this.machineId, envId, path);
    assertVersionMatch(ifMatch, path, r.size, r.modifiedAt);
  }

  async tree(envId: string): Promise<TreeResult> {
    return remoteTree(this.machineId, envId);
  }
  async list(envId: string, path: string): Promise<FileEntry[]> {
    return remoteListDir(this.machineId, envId, path);
  }
  async read(envId: string, path: string, mode: ReadMode): Promise<ReadResult> {
    if (mode === "binary") return this.readBinary(envId, path);
    try {
      const r = await remoteReadFile(this.machineId, envId, path);
      // 远程数据源无 mtime（机器端补 mtime 属跨仓库增强）→ mtimeMs 缺省，
      // 路由层据 size 计算 size-only 弱指纹
      return { type: "text", name: r.name, path: r.path, content: r.content, size: r.size, encoding: r.encoding };
    } catch (err) {
      // auto 模式：文本失败回退二进制（现状 fs.ts 语义）；text 模式失败向上抛（W13' 明确错误）
      if (mode !== "auto") throw err;
      return this.readBinary(envId, path);
    }
  }
  private async readBinary(envId: string, path: string): Promise<ReadResult> {
    const r = await remoteReadBinaryFile(this.machineId, envId, path);
    return {
      type: "binary",
      name: r.name,
      path: r.path,
      size: r.size,
      mimeType: r.mimeType,
      // 远程走 base64 单帧（现状语义）；流由内存缓冲构造，与现状 buffer 等价
      stream: Readable.from(Buffer.from(r.data, "base64")),
    };
  }
  async write(envId: string, path: string, content: string, options?: FileWriteOptions): Promise<WriteResult> {
    await this.assertRemoteIfMatch(envId, path, options?.ifMatch);
    return remoteWriteFile(this.machineId, envId, path, content, this.remoteOptions(options));
  }
  async upload(
    envId: string,
    dir: string,
    files: UploadFileInput[],
    options?: FileWriteOptions,
  ): Promise<UploadResult> {
    await this.assertRemoteIfMatch(envId, dir, options?.ifMatch);
    return remoteUploadFiles(
      this.machineId,
      envId,
      dir,
      files.map((f) => ({
        name: f.name,
        content: Buffer.from(f.content).toString("base64"),
        relativePath: f.relativePath ?? f.name,
      })),
      this.remoteOptions(options),
    );
  }
  async delete(envId: string, path: string, options?: FileWriteOptions): Promise<void> {
    await this.assertRemoteIfMatch(envId, path, options?.ifMatch);
    await remoteDeleteFile(this.machineId, envId, path, this.remoteOptions(options));
  }
  async mkdir(envId: string, path: string, options?: FileWriteOptions): Promise<void> {
    await this.assertRemoteIfMatch(envId, path, options?.ifMatch);
    await remoteMkdir(this.machineId, envId, path, this.remoteOptions(options));
  }
  async rename(envId: string, oldPath: string, newPath: string, options?: FileWriteOptions): Promise<void> {
    await this.assertRemoteIfMatch(envId, oldPath, options?.ifMatch);
    await remoteRename(this.machineId, envId, oldPath, newPath, this.remoteOptions(options));
  }
  async stat(envId: string, path: string): Promise<StatResult> {
    const r = await remoteStat(this.machineId, envId, path);
    return { size: r.size, isDirectory: r.isDirectory, modifiedAt: r.modifiedAt };
  }
  async downloadZip(envId: string, path: string): Promise<NodeJS.ReadableStream> {
    // W16：远程 zip 补齐——file_op "zip" 单帧回传（base64）后解码为流，路由层流式
    // 转发（Content-Disposition 由路由设置）；>20MB 在 remoteZip 内已 413 拒绝，不截断；
    // 分块回传（file_op_chunk）属二期，单帧 ≤20MB 为过渡契约
    const base64 = await remoteZip(this.machineId, envId, path);
    return Readable.from(Buffer.from(base64, "base64"));
  }
}

// ── BackEnd 路由决策（§3 回退链，门面 resolveExecutionBackend）─────────
/** BackEnd 路由决策（§3 回退链）：agentConfig.machineId → RCS_DEFAULT_MACHINE_ID
 *  → null 本地。配了 machine 但 file-ws 未连接时 getRemoteMachineId 抛 503，
 *  拒绝静默回退。决策不缓存，每次操作实时判定（连接状态会变）。 */
export async function resolveExecutionBackend(envId: string): Promise<BackEnd> {
  const machineId = await getRemoteMachineId(envId);
  return machineId ? new RemoteBackend(machineId) : new LocalBackend();
}
