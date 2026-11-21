import { cc, dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  fchmodSync,
  fstat,
  fstatSync,
  fsync,
  fsyncSync,
  read as readBytes,
  type Stats,
  writeFile,
} from "node:fs";
import { lstat, mkdtemp, realpath, rm, writeFile as writeSource } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";
// @ts-expect-error Bun embeds this file; the ES2022 checker lacks file import attributes.
import openatSource from "./secure-openat.c" with { type: "file" };
import { runWorkspaceUpload } from "./workspace-upload-receipts";

const statFd = promisify(fstat);
const syncFd = promisify(fsync);
const writeFd = promisify(writeFile);
const MAX_BYTES = 92 * 1024 * 1024;

/** Stop at the hard byte budget even when another process keeps growing the file. */
async function readFd(fd: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_BYTES + 1 - size));
    const count = await new Promise<number>((accept, reject) =>
      readBytes(fd, chunk, 0, chunk.length, null, (error, bytes) => (error ? reject(error) : accept(bytes))),
    );
    if (!count) return Buffer.concat(chunks, size);
    size += count;
    if (size > MAX_BYTES) throw Object.assign(new Error("File exceeds 92MB limit"), { code: "EFBIG" });
    chunks.push(chunk.subarray(0, count));
  }
}

/** Content identity of the exact bytes returned or committed. */
export function workspaceContentVersion(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Apply the new file-operation path policy without changing the original exclusive-create contract. */
function assertFileOperationPath(workspace: string, path: string): void {
  const local = relative(resolve(workspace), resolve(workspace, path));
  if (
    !local ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    path.split(/[\\/]+/).some((part) => part === "..") ||
    [...path].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    })
  )
    throw Object.assign(new Error("Invalid upload path"), { code: "EINVAL" });
}

/** Resolve in-workspace directory aliases while keeping the final entry literal for O_NOFOLLOW. */
export async function resolveWorkspaceFileParent(workspace: string, path: string): Promise<string> {
  assertFileOperationPath(workspace, path);
  const root = await realpath(workspace);
  const target = resolve(workspace, path);
  const missing: string[] = [];
  let parent = dirname(target);
  for (;;) {
    try {
      const canonical = await realpath(parent);
      const inside = relative(root, canonical);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
        throw Object.assign(new Error("Workspace parent resolves outside its root"), { code: "ELOOP" });
      return relative(root, join(canonical, ...missing, basename(target)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(basename(parent));
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

/** Explicit overwrite is required for conditional replacement. */
export interface WorkspaceUploadOptions {
  /** Cancellation fences the final rename even if a pending filesystem call completes later. */
  signal?: AbortSignal;
  overwrite?: boolean;
  expectedVersion?: string;
  opId?: string;
}

/** Fixed-ABI native calls need no compiler or development headers on the machine. */
async function nativeFilesystem() {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Secure uploads require a POSIX runtime");
  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    renameat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    unlinkat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    [process.platform === "darwin" ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
  });
  if (process.platform === "linux") return { libc, openAt: libc.symbols.openat };
  const directory = await mkdtemp(join(tmpdir(), "fenix-upload-native-"));
  try {
    const source = join(directory, "openat.c");
    await writeSource(source, new Uint8Array(await Bun.file(openatSource).arrayBuffer()), { mode: 0o600 });
    const wrapper = cc({
      source,
      flags: ["-nostdlib"],
      symbols: {
        fenix_openat: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      },
    });
    // Bun's runtime symbol pointer is missing from bun-types.
    const openatPointer = (libc.symbols.openat as unknown as { ptr: Pointer }).ptr;
    return {
      libc,
      openAt: (directory: number, path: Pointer, flags: number, mode: number) =>
        wrapper.symbols.fenix_openat(openatPointer, directory, path, flags, mode),
    };
  } catch (error) {
    libc.close();
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
let native: ReturnType<typeof nativeFilesystem> | undefined;

function conflict(): Error {
  return Object.assign(new Error("File content or target type has changed"), { code: "VERSION_CONFLICT" });
}

/** Walk every component using O_NOFOLLOW; the callback never reopens a checked string path. */
async function withParent<T>(
  workspace: string,
  path: string,
  create: boolean,
  run: (io: {
    directory: number;
    name: string;
    open: (name: string, flags: number) => number;
    close: (fd: number) => void;
    rename: (from: string, to: string) => void;
    unlink: (name: string) => void;
  }) => Promise<T>,
): Promise<T> {
  const local = relative(resolve(workspace), resolve(workspace, path));
  if (!local || isAbsolute(path) || local === ".." || local.startsWith(`..${sep}`) || path.includes("\0"))
    throw new Error("Invalid upload path");
  if ((await lstat(workspace)).isSymbolicLink())
    throw Object.assign(new Error("Unsafe workspace symbolic link"), { code: "ELOOP" });
  const root = await realpath(workspace);
  if (!native) native = nativeFilesystem();
  const loaded = await native;
  const api = loaded.libc.symbols;
  const errno = () => read.i32(api[process.platform === "darwin" ? "__error" : "__errno_location"]!() as Pointer);
  const failure = () => {
    const value = errno();
    return Object.assign(new Error("Secure workspace operation failed"), {
      code:
        (
          {
            2: "ENOENT",
            17: "EEXIST",
            20: "ENOTDIR",
            21: "EISDIR",
            [process.platform === "darwin" ? 62 : 40]: "ELOOP",
          } as Record<number, string>
        )[value] ?? "EIO",
      errno: value,
    });
  };
  const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000;
  const openAt = (parent: number, name: string, flags: number) => {
    const encoded = Buffer.from(`${name}\0`);
    const fd = loaded.openAt(parent, ptr(encoded), flags | constants.O_NOFOLLOW | closeOnExec, 0o600);
    if (fd < 0) throw failure();
    return fd;
  };
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY;
  let directory = openAt(process.platform === "darwin" ? -2 : -100, "/", directoryFlags);
  try {
    for (const name of root.split(sep).filter(Boolean)) {
      const next = openAt(directory, name, directoryFlags);
      api.close(directory);
      directory = next;
    }
    const parts = local.split(sep);
    for (const name of parts.slice(0, -1)) {
      if (create) {
        const encoded = Buffer.from(`${name}\0`);
        if (api.mkdirat(directory, ptr(encoded), 0o700) < 0 && errno() !== 17) throw failure();
      }
      const next = openAt(directory, name, directoryFlags);
      api.close(directory);
      directory = next;
    }
    return await run({
      directory,
      name: parts.at(-1)!,
      open: (name, flags) => openAt(directory, name, flags),
      close: (fd) => {
        api.close(fd);
      },
      rename: (from, to) => {
        const a = Buffer.from(`${from}\0`),
          b = Buffer.from(`${to}\0`);
        if (api.renameat(directory, ptr(a), directory, ptr(b)) < 0) throw failure();
      },
      unlink: (name) => {
        const encoded = Buffer.from(`${name}\0`);
        if (api.unlinkat(directory, ptr(encoded), 0) < 0 && errno() !== 2) throw failure();
      },
    });
  } finally {
    api.close(directory);
  }
}

/** Read and hash the same descriptor without following workspace symlinks. */
export async function readWorkspaceFileSnapshot(
  workspace: string,
  path: string,
): Promise<{ content: Buffer; version: string; modifiedAt: number }> {
  return withParent(workspace, await resolveWorkspaceFileParent(workspace, path), false, async (io) => {
    const fd = io.open(io.name, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await statFd(fd);
      if (!info.isFile()) throw Object.assign(new Error("Target is not a regular file"), { code: "EINVAL" });
      if (info.size > MAX_BYTES) throw Object.assign(new Error("File exceeds 92MB limit"), { code: "EFBIG" });
      const content = await readFd(fd);
      if (content.byteLength > MAX_BYTES) throw Object.assign(new Error("File exceeds 92MB limit"), { code: "EFBIG" });
      return { content, version: workspaceContentVersion(content), modifiedAt: info.mtimeMs };
    } finally {
      io.close(fd);
    }
  });
}

/** Atomically create or replace a regular file; receipts are checked before stale version conditions. */
export async function uploadWorkspaceFile(
  workspace: string,
  path: string,
  content: Uint8Array,
  options: WorkspaceUploadOptions = {},
  beforeCommit?: () => Promise<void>,
): Promise<{ version: string }> {
  options.signal?.throwIfAborted();
  assertFileOperationPath(workspace, path);
  if (options.expectedVersion !== undefined && (!options.overwrite || !/^[a-f0-9]{64}$/.test(options.expectedVersion)))
    throw Object.assign(new Error("A content version requires explicit overwrite"), { code: "EINVAL" });
  // 上传与文本写入有不同的既有容量契约，由各自的协议入口校验写入大小。
  const bytes = Buffer.from(content);
  const version = workspaceContentVersion(bytes);
  return runWorkspaceUpload(resolve(workspace, path), options, version, () =>
    withParent(workspace, path, true, async (io) => {
      options.signal?.throwIfAborted();
      if (!options.overwrite) {
        await beforeCommit?.();
        options.signal?.throwIfAborted();
        const fd = io.open(io.name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
        try {
          await writeFd(fd, bytes);
          await syncFd(fd);
        } finally {
          io.close(fd);
        }
        return { version };
      }
      const temporary = `.fenix-upload-${randomUUID()}`;
      const fd = io.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      let staged = true;
      try {
        await writeFd(fd, bytes);
        await syncFd(fd);
        await beforeCommit?.();
        options.signal?.throwIfAborted();
        let target: number | undefined;
        let checked: Stats | undefined;
        try {
          target = io.open(io.name, constants.O_RDONLY | constants.O_NONBLOCK);
          const info = await statFd(target);
          checked = info;
          if (!info.isFile())
            throw options.expectedVersion
              ? conflict()
              : Object.assign(new Error("Target is not a regular file"), { code: "EINVAL" });
          if (options.expectedVersion !== undefined) {
            if (info.size > MAX_BYTES || workspaceContentVersion(await readFd(target)) !== options.expectedVersion)
              throw conflict();
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (options.expectedVersion !== undefined && ["ENOENT", "ELOOP", "ENOTDIR", "EISDIR"].includes(code ?? ""))
            throw conflict();
          if (code !== "ENOENT" || options.expectedVersion !== undefined) throw error;
        } finally {
          if (target !== undefined) io.close(target);
        }
        // Reopen after asynchronous hashing so deletion or replacement during the read cannot be recreated silently.
        let current: number | undefined;
        try {
          current = io.open(io.name, constants.O_RDONLY | constants.O_NONBLOCK);
          const latest = fstatSync(current);
          if (!latest.isFile())
            throw options.expectedVersion
              ? conflict()
              : Object.assign(new Error("Target is not a regular file"), { code: "EINVAL" });
          if (
            options.expectedVersion &&
            (!checked ||
              latest.dev !== checked.dev ||
              latest.ino !== checked.ino ||
              latest.size !== checked.size ||
              latest.mtimeMs !== checked.mtimeMs ||
              latest.ctimeMs !== checked.ctimeMs)
          )
            throw conflict();
          // Preserve ordinary permissions, including executable bits, without carrying privilege bits to new content.
          fchmodSync(fd, latest.mode & 0o777);
          fsyncSync(fd);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (options.expectedVersion && ["ENOENT", "ELOOP", "ENOTDIR", "EISDIR", "EFBIG"].includes(code ?? ""))
            throw conflict();
          if (code !== "ENOENT" || options.expectedVersion) throw error;
        } finally {
          if (current !== undefined) io.close(current);
        }
        // renameat replaces the directory entry; it never follows a destination symlink or truncates its referent.
        options.signal?.throwIfAborted();
        io.rename(temporary, io.name);
        staged = false;
        return { version };
      } finally {
        io.close(fd);
        if (staged) io.unlink(temporary);
      }
    }).catch((error: unknown) => {
      if (
        options.expectedVersion &&
        ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw conflict();
      throw error;
    }),
  );
}

/** Create a confined file without overwrite; transport limits remain the caller's responsibility. */
export async function uploadWorkspaceFileExclusive(
  workspace: string,
  path: string,
  content: Uint8Array,
  beforeOpen?: () => Promise<void>,
): Promise<void> {
  // 旧公开接口只承诺排他创建和路径隔离，不继承新增编辑原语的容量、版本或重试策略。
  await withParent(workspace, path, true, async (io) => {
    await beforeOpen?.();
    const fd = io.open(io.name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try {
      await writeFd(fd, content);
    } finally {
      io.close(fd);
    }
  });
}
