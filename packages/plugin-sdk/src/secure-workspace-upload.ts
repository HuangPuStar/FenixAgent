import { cc, dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";
import { constants, writeFile } from "node:fs";
import { lstat, mkdtemp, realpath, rm, writeFile as writeSource } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// @ts-expect-error Bun embeds this file; the ES2022 checker lacks file import attributes.
import openatSource from "./secure-openat.c" with { type: "file" };

/** Fixed-ABI native calls require no compiler, headers, or development libraries on the machine. */
async function nativeFilesystem() {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Secure uploads require a POSIX runtime");
  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    openat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    mkdirat: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    [process.platform === "darwin" ? "__error" : "__errno_location"]: { args: [], returns: FFIType.ptr },
  });
  if (process.platform === "linux") return { libc, openAt: libc.symbols.openat };
  // cc needs an OS path even when Bun embeds the source into a standalone executable.
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
    // Bun exposes the loaded symbol pointer at runtime; bun-types omits this property.
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

/** Create a new workspace file without following symlinks or overwriting an existing file. */
export async function uploadWorkspaceFileExclusive(
  workspace: string,
  path: string,
  content: Uint8Array,
  beforeOpen?: () => Promise<void>,
): Promise<void> {
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
  const failure = (value: number) =>
    Object.assign(new Error("Secure workspace upload failed"), {
      code:
        ({ 17: "EEXIST", 20: "ENOTDIR", [process.platform === "darwin" ? 62 : 40]: "ELOOP" } as Record<number, string>)[
          value
        ] ?? "EIO",
      errno: value,
    });
  const open = (parent: number, name: string, flags: number) => {
    const encoded = Buffer.from(`${name}\0`);
    const fd = loaded.openAt(parent, ptr(encoded), flags, 0o600);
    if (fd < 0) throw failure(errno());
    return fd;
  };
  const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000;
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
  let directory = open(process.platform === "darwin" ? -2 : -100, "/", directoryFlags);
  let file: number | undefined;
  try {
    // The trusted root is also walked component by component; never reopen a checked string path.
    for (const name of root.split(sep).filter(Boolean)) {
      const next = open(directory, name, directoryFlags);
      api.close(directory);
      directory = next;
    }
    const parts = local.split(sep);
    for (const name of parts.slice(0, -1)) {
      const encoded = Buffer.from(`${name}\0`);
      if (api.mkdirat(directory, ptr(encoded), 0o700) < 0) {
        const value = errno();
        if (value !== 17) throw failure(value);
      }
      const next = open(directory, name, directoryFlags);
      api.close(directory);
      directory = next;
    }
    await beforeOpen?.();
    file = open(
      directory,
      parts.at(-1)!,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | closeOnExec,
    );
    await new Promise<void>((accept, reject) =>
      writeFile(file!, content, (error) => (error ? reject(error) : accept())),
    );
  } finally {
    if (file !== undefined) api.close(file);
    api.close(directory);
  }
}
