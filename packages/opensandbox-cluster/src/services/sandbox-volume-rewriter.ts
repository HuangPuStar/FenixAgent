import { posix } from "node:path";

export class SandboxVolumeRewriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxVolumeRewriteError";
  }
}

function normalizeRelativePath(value: string): string {
  if (value.includes("\0")) throw new SandboxVolumeRewriteError("volume host path contains a NUL byte");

  const slashPath = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (/^[A-Za-z]:\//.test(slashPath)) {
    throw new SandboxVolumeRewriteError("volume host path must be relative to the sandbox workspace");
  }

  const normalized = posix.normalize(slashPath);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new SandboxVolumeRewriteError("volume host path escapes the sandbox workspace");
  }
  return normalized === "." ? "" : normalized;
}

function workspacePath(workspaceRoot: string, path: string): string {
  const relativePath = normalizeRelativePath(path);
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root.startsWith("/") || root === "/" || root.includes("\0") || root.includes("/../") || root.endsWith("/..")) {
    throw new SandboxVolumeRewriteError("workspace root must be a safe absolute path");
  }
  return relativePath ? `${root}/${relativePath}` : root;
}

/** Rewrites caller-provided host volume paths into the configured Server workspace. */
export function rewriteSandboxCreateBody(body: unknown, workspaceRoot: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SandboxVolumeRewriteError("sandbox create body must be an object");
  }

  const input = body as { volumes?: unknown };
  if (input.volumes === undefined) return body;
  if (!Array.isArray(input.volumes)) throw new SandboxVolumeRewriteError("volumes must be an array");

  return {
    ...input,
    volumes: input.volumes.map((volume) => {
      if (!volume || typeof volume !== "object" || Array.isArray(volume)) {
        throw new SandboxVolumeRewriteError("volume must be an object");
      }
      const item = volume as { host?: unknown } & Record<string, unknown>;
      if (!item.host || typeof item.host !== "object" || Array.isArray(item.host)) return volume;

      const host = item.host as { path?: unknown } & Record<string, unknown>;
      if (typeof host.path !== "string" || host.path.length === 0) {
        throw new SandboxVolumeRewriteError("host volume path is required");
      }

      return {
        ...item,
        host: {
          ...host,
          path: workspacePath(workspaceRoot, host.path),
        },
      };
    }),
  };
}

/** Returns whether the proxied request is the OpenSandbox lifecycle create endpoint. */
export function isSandboxCreateRequest(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && path.replace(/^\/+|\/+$/g, "") === "v1/sandboxes";
}
