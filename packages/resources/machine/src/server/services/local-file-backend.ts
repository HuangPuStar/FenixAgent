/** 本地与远程文件执行后端，共享条件写规则；门面负责授权并选择后端。 */

import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { NotFoundError, ValidationError } from "@fenix/platform-sdk";
import {
  readWorkspaceFileSnapshot,
  resolveWorkspaceFileParent,
  uploadWorkspaceFile,
} from "@fenix/plugin-sdk/secure-workspace-upload";
import { buildDownloadZipEnv } from "./download-zip-env";
import type { BackEnd } from "./file-backends";
import { type FileChangeKind, publishFileChanged } from "./file-event-limiter";
import { normalizeUploadRelativePath } from "./file-path-validator";
import { assertVersionMatch } from "./file-preconditions";
import {
  type FileReadOptions,
  FileServiceError,
  type FileUploadOptions,
  type FileWriteOptions,
  LOCAL_UPLOAD_MAX_BYTES,
  type ReadMode,
  type ReadResult,
  type StatResult,
  type TreeResult,
  type UploadFileInput,
  type UploadResult,
  type WriteResult,
} from "./file-types";

import { uploadFailure } from "./file-upload-errors";
import {
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
} from "./workspace-fs";

let uploadBeforeWriteHook: ((destination: string) => Promise<void>) | undefined;

/** 仅供上传竞态行为测试在 mkdir 与真实落点复检之间替换目录。 */
export function setLocalUploadBeforeWriteHookForTest(hook?: (destination: string) => Promise<void>): void {
  uploadBeforeWriteHook = hook;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * 上传落盘前逐段拒绝 symlink，并在 mkdir 后重新校验父目录真实落点。
 * 第二次检查刻意紧邻 writeFile，避免只在批次开始时检查造成明显 TOCTOU 窗口。
 */
async function assertUploadDestination(workspaceDir: string, destination: string): Promise<void> {
  const workspaceRealPath = await realpath(workspaceDir);
  const rel = relative(workspaceDir, destination);
  if (!isWithinRoot(workspaceDir, destination)) throw new ValidationError("上传目标路径越出 workspace");

  let current = workspaceDir;
  for (const segment of rel.split(sep).slice(0, -1)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new ValidationError("上传目标路径包含 symbolic link");
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
      break;
    }
  }

  const parentRealPath = await realpath(dirname(destination));
  if (!isWithinRoot(workspaceRealPath, parentRealPath)) throw new ValidationError("上传目标路径越出 workspace");
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw new ValidationError("上传目标文件是 symbolic link");
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

/** 本地实现：包装 workspace-fs（opId/ifMatch 为契约占位，W12b 启用） */
export class LocalBackend implements BackEnd {
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
    const sizes: Record<string, number> = {};
    for (const e of entries) {
      if (e.mtime > 0) mtimes[e.path] = e.mtime;
      if (e.size !== undefined) sizes[e.path] = e.size;
    }
    return { paths: entries.map((e) => e.path), mtimes, sizes, errors: errors.length > 0 ? errors : undefined };
  }
  async list(envId: string, path: string): Promise<FileEntry[]> {
    const resolved = await this.resolve(envId, path);
    const info = await stat(resolved.resolved);
    if (!info.isDirectory()) throw new ValidationError("目标不是目录，请使用 read 接口");
    return listDirectory(resolved.resolved, resolved.userDir, resolved.workspaceDir);
  }

  async read(envId: string, path: string, mode: ReadMode, options?: FileReadOptions): Promise<ReadResult> {
    const resolved = await this.resolve(envId, path);
    const info = await this.statOr404(resolved.resolved, "文件不存在");
    if (info.isDirectory()) throw new ValidationError("目标是目录，请使用 list 接口");
    if (options?.includeVersion) {
      const snapshot = await readWorkspaceFileSnapshot(resolved.workspaceDir, path);
      const name = path.substring(path.lastIndexOf("/") + 1);
      const ext = name.includes(".") ? name.substring(name.lastIndexOf(".")) : "";
      const textFile = isTextExtension(ext) || (!ext && !snapshot.content.includes(0));
      if (mode === "text" && !textFile)
        throw new FileServiceError("该文件不是文本文件，暂不支持预览", "validation_error", 400);
      if (mode === "binary" || (mode === "auto" && !(isTextExtension(ext) || (!ext && !snapshot.content.includes(0)))))
        return {
          type: "binary",
          name,
          path: resolved.displayPath,
          size: snapshot.content.byteLength,
          mimeType: getMimeType(ext),
          stream: Readable.from(snapshot.content),
          version: snapshot.version,
          mtimeMs: snapshot.modifiedAt,
        };
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.content);
      } catch {
        throw new FileServiceError("不支持该文件的文本编码", "validation_error", 400);
      }
      return {
        type: "text",
        name,
        path: resolved.displayPath,
        content,
        size: snapshot.content.byteLength,
        encoding: "utf-8",
        version: snapshot.version,
        mtimeMs: snapshot.modifiedAt,
      };
    }
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
    // Conditional saves must reach the descriptor-based check even if the old target became an unsafe link.
    const resolved = await this.resolve(envId, options?.expectedVersion === undefined ? path : ".");
    const target = options?.expectedVersion === undefined ? resolved.resolved : join(resolved.workspaceDir, path);
    await this.assertLocalIfMatch(target, path, options?.ifMatch);
    const committed = await uploadWorkspaceFile(
      resolved.workspaceDir,
      await resolveWorkspaceFileParent(resolved.workspaceDir, path),
      Buffer.from(content),
      {
        overwrite: !options?.createOnly,
        expectedVersion: options?.expectedVersion,
        opId: options?.opId,
      },
    );
    const name = path.substring(path.lastIndexOf("/") + 1);
    this.publishLocal(envId, "write", path, options);
    return {
      name,
      path: relative(resolved.workspaceDir, target),
      size: Buffer.byteLength(content),
      ...(options?.expectedVersion !== undefined ? { version: committed.version } : {}),
    };
  }
  async upload(
    envId: string,
    dir: string,
    files: UploadFileInput[],
    options?: FileUploadOptions,
  ): Promise<UploadResult> {
    const { resolved, workspaceDir } = await this.resolve(envId, dir);
    // 目标目录条件写比对：目录被删/被改（mtime 变）→ 409；新建目录不应带 If-Match
    await this.assertLocalIfMatch(resolved, dir, options?.ifMatch);
    const uploaded: UploadResult["files"] = [];
    for (const [index, file] of files.entries()) {
      const relPath = normalizeUploadRelativePath(file.relativePath) || file.name;
      const destPath = join(resolved, relPath);
      let version: string;
      try {
        const committed = await uploadWorkspaceFile(
          workspaceDir,
          relative(workspaceDir, destPath),
          file.content,
          {
            overwrite: options?.overwrite,
            expectedVersion: file.expectedVersion,
            opId: options?.opId,
            signal: options?.signal,
          },
          async () => {
            await uploadBeforeWriteHook?.(destPath);
            if (file.expectedVersion === undefined) await assertUploadDestination(workspaceDir, destPath);
          },
        );
        version = committed.version;
      } catch (error) {
        if (options?.overwrite)
          throw uploadFailure(error, {
            completedFiles: uploaded,
            failedFile: dir ? `${dir}/${relPath}` : relPath,
            remainingFiles: files
              .slice(index + 1)
              .map((next) =>
                [dir, normalizeUploadRelativePath(next.relativePath) || next.name].filter(Boolean).join("/"),
              ),
          });
        if (isErrnoException(error) && ["ELOOP", "ENOTDIR"].includes(error.code ?? ""))
          throw new ValidationError("上传目标路径包含 symbolic link");
        throw error;
      }
      const displayPath = dir ? `${dir}/${relPath}` : relPath;
      uploaded.push({
        name: file.name,
        path: displayPath,
        size: file.content.byteLength,
        ...(options?.overwrite ? { version } : {}),
      });
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
  async stat(envId: string, path: string, options?: FileReadOptions): Promise<StatResult> {
    const resolved = await this.resolve(envId, path);
    const info = await this.statOr404(resolved.resolved, "文件不存在");
    const snapshot =
      options?.includeVersion && info.isFile()
        ? await readWorkspaceFileSnapshot(resolved.workspaceDir, path)
        : undefined;
    return {
      ...(snapshot ? { version: snapshot.version } : {}),
      size: snapshot?.content.byteLength ?? info.size,
      isDirectory: info.isDirectory(),
      modifiedAt: snapshot?.modifiedAt ?? info.mtimeMs,
      isText: info.isFile() ? await isTextFile(resolved.resolved) : undefined,
    };
  }
  async downloadZip(envId: string, path: string): Promise<NodeJS.ReadableStream> {
    const resolved = await this.resolve(envId, path);
    const info = await this.statOr404(resolved.resolved, "路径不存在");
    if (!info.isDirectory()) throw new ValidationError("目标不是目录");
    const child = spawn("zip", ["-r", "-q", "-", "."], {
      cwd: resolved.resolved,
      // 按用途白名单构造环境（§5.4）：zip 会把宿主的 ZIPOPT/ZIP 当命令行选项，且不得拿到宿主密钥
      env: buildDownloadZipEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    // @types/node 22.20.1 缺陷：class EventEmitter 的实例方法声明在 interface 合并中，
    // `class ChildProcess extends EventEmitter` 的类型丢失 on/once（运行时存在，
    // Node 25 类型已修复）。最小断言恢复事件 API，不触碰 stdout/kill 等成员。
    const childEvents = child as unknown as NodeJS.EventEmitter;
    // 等待 spawn 确认（zip 缺失/不可执行时 error 先于 spawn 触发）：统一映射
    // 503 file_service_unavailable（§2.4 契约）。不得把 error 留给已返回的流——
    // headers 发出后无法再返回 JSON 错误，只能中断连接，消费者不可诊断
    await new Promise<void>((resolveSpawn, reject) => {
      childEvents.once("spawn", () => resolveSpawn());
      childEvents.once("error", (err: Error) => {
        // spawn 失败后 stdout 已无数据，显式销毁避免其 error 事件泄漏为未捕获错误；
        // 原始错误只进诊断日志（err.message 含命令路径等部署细节，不得泄露给响应）
        child.stdout.destroy();
        console.error("downloadZip spawn zip 失败", err);
        reject(new FileServiceError("目录打包服务暂不可用，请稍后重试", "file_service_unavailable", 503));
      });
    });
    const stream = child.stdout;
    // 客户端断开（Response body 被 destroy/abort）时流只触发 close 不触发 end，
    // 此时必须 kill 子进程防悬空；正常打包完成先 end 再 close，不得误 kill
    // 正常收尾的进程（zip 写完 stdout 后自然退出）
    let endedNormally = false;
    stream.once("end", () => {
      endedNormally = true;
    });
    stream.once("close", () => {
      if (!endedNormally) child.kill();
    });
    return stream;
  }
}
