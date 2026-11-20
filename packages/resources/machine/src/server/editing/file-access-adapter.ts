import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  EDITING_DEFAULTS,
  EditingError,
  type EditingFileAccess,
  type EditingScope,
} from "@fenix/file-editing/contracts";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { machineFileFacade } from "../facades/machine-file-facade";
import type { AgentFileService } from "../services/agent-file-service";
import { FileServiceError } from "../services/file-types";

type FileAccess = Pick<AgentFileService, "stat" | "read" | "upload">;
type OpenFiles = (scope: EditingScope) => Promise<FileAccess>;

/** Provider callbacks have no browser session; restore current membership before environment authorization. */
async function openAuthorizedFiles(scope: EditingScope): Promise<FileAccess> {
  const memberships = await getIdentityDirectory().listMemberships(scope.userId);
  if (!memberships.some((membership) => membership.organizationId === scope.organizationId)) {
    throw new EditingError("forbidden", "Workspace membership is no longer valid");
  }
  return machineFileFacade.open(scope, scope.environmentId);
}

/** Translate Machine execution failures at the package boundary, preserving safe domain context. */
export function asEditingError(error: unknown): never {
  if (error instanceof EditingError) throw error;
  if (error instanceof FileServiceError) {
    const code = {
      version_conflict: "conflict",
      path_conflict: "conflict",
      not_found: "not-found",
      forbidden: "forbidden",
      payload_too_large: "too-large",
      busy: "busy",
      validation_error: "invalid-input",
      config_error: "unavailable",
      file_service_unavailable: "unavailable",
    } as const;
    throw new EditingError(code[error.type], error.message);
  }
  throw error;
}

/** Adapt authorized Machine file operations to the replaceable editing package's narrow port. */
export function createEditingFileAccess(open: OpenFiles = openAuthorizedFiles): EditingFileAccess {
  return {
    async authorize(scope) {
      try {
        await open(scope);
      } catch (error) {
        return asEditingError(error);
      }
    },
    async stat(scope, path) {
      try {
        const result = await (await open(scope)).stat(path, { includeVersion: true });
        if (!result.isDirectory && !result.version)
          throw new EditingError("unavailable", "File content versions are unavailable");
        return { size: result.size, isDirectory: result.isDirectory, version: result.version ?? "" };
      } catch (error) {
        return asEditingError(error);
      }
    },
    async readSnapshot(scope, path) {
      try {
        const result = await (await open(scope)).read(path, "binary", { includeVersion: true });
        if (result.type !== "binary" || !result.version)
          throw new EditingError("unavailable", "Versioned binary snapshots are unavailable");
        if (result.size > EDITING_DEFAULTS.maxFileBytes)
          throw new EditingError("too-large", "File exceeds editing limit");
        if (!(result.stream instanceof Readable)) throw new EditingError("unavailable", "Unsupported file stream");
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const value of result.stream) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            size += chunk.byteLength;
            if (size > EDITING_DEFAULTS.maxFileBytes) throw new EditingError("too-large", "File exceeds editing limit");
            chunks.push(chunk);
          }
        } finally {
          result.stream.destroy();
        }
        const bytes = Buffer.concat(chunks, size);
        if (createHash("sha256").update(bytes).digest("hex") !== result.version)
          throw new EditingError("conflict", "File changed during loading");
        return { path: result.path, bytes, size, version: result.version, mimeType: result.mimeType };
      } catch (error) {
        return asEditingError(error);
      }
    },
    async upload(scope, path, bytes, options) {
      try {
        const fs = await open(scope);
        const slash = path.lastIndexOf("/");
        const parent = slash < 0 ? "" : path.slice(0, slash);
        const name = path.slice(slash + 1);
        const result = await fs.upload(parent, [{ name, content: bytes, expectedVersion: options.expectedVersion }], {
          overwrite: true,
          signal: options.signal,
          opId: options.opId,
        });
        const saved = result.files[0];
        if (!saved?.version || saved.path !== path)
          throw new EditingError("unavailable", "File service did not return the saved target version");
        return { path: saved.path, size: saved.size, version: saved.version };
      } catch (error) {
        return asEditingError(error);
      }
    },
  };
}
