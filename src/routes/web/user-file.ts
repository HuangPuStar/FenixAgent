import { stat } from "node:fs/promises";
import Elysia from "elysia";
import { NotFoundError } from "../../errors";
import { authGuardPlugin } from "../../plugins/auth";
import {
  BatchDeleteRequestSchema,
  BatchDeleteResponseSchema,
  MkdirRequestSchema,
  MkdirResponseSchema,
  RenameRequestSchema,
  RenameResponseSchema,
  TreeResponseSchema,
} from "../../schemas/file.schema";
import { getOwnedEnvironment } from "../../services/environment-core";
import {
  deleteFile,
  isUserPath,
  listPathsRecursive,
  mkdirp,
  renamePath,
  resolveWorkspacePath,
} from "../../services/workspace-fs";

const app = new Elysia({ name: "web-user-file", prefix: "/web/environments" })
  .use(authGuardPlugin)
  .model({
    "tree-response": TreeResponseSchema,
    "rename-request": RenameRequestSchema,
    "rename-response": RenameResponseSchema,
    "mkdir-request": MkdirRequestSchema,
    "mkdir-response": MkdirResponseSchema,
    "batch-delete-request": BatchDeleteRequestSchema,
    "batch-delete-response": BatchDeleteResponseSchema,
  });

async function requireEnv(envId: string, orgId: string, errorFn: (status: number, body: unknown) => any) {
  try {
    return await getOwnedEnvironment(envId, orgId);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return errorFn(404, { error: { type: "not_found", message: "环境不存在" } });
    }
    throw e;
  }
}

// GET /:id/user-file/tree — 递归列出 user/ 下所有路径
app.get(
  "/:id/user-file/tree",
  async ({ store, params, error }) => {
    const authCtx = store.authContext!;
    const env = await requireEnv(params.id, authCtx.organizationId, error);
    const paths = await listPathsRecursive(env.workspacePath);
    return { paths };
  },
  { sessionAuth: true },
);

// POST /:id/user-file/rename — 重命名/移动文件或目录
app.post(
  "/:id/user-file/rename",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    await requireEnv(params.id, authCtx.organizationId, error);
    const { oldPath, newPath } = body as { oldPath: string; newPath: string };

    if (!isUserPath(oldPath) || !isUserPath(newPath)) {
      return error(400, { error: { type: "validation_error", message: "Only user/ paths are allowed" } });
    }

    const oldResolved = await resolveWorkspacePath(params.id, oldPath);
    if (!oldResolved) return error(404, { error: { type: "not_found", message: "Source not found" } });

    try {
      await stat(oldResolved.resolved);
    } catch {
      return error(404, { error: { type: "not_found", message: "Source not found" } });
    }

    const newResolved = await resolveWorkspacePath(params.id, newPath);
    if (!newResolved) return error(400, { error: { type: "validation_error", message: "Invalid destination" } });

    await renamePath(oldResolved.resolved, newResolved.resolved);
    return { oldPath, newPath };
  },
  { sessionAuth: true, body: "rename-request" },
);

// POST /:id/user-file/mkdir — 创建目录
app.post(
  "/:id/user-file/mkdir",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    await requireEnv(params.id, authCtx.organizationId, error);
    const { path } = body as { path: string };

    if (!isUserPath(path)) {
      return error(400, { error: { type: "validation_error", message: "Only user/ paths are allowed" } });
    }

    const resolved = await resolveWorkspacePath(params.id, path);
    if (!resolved) return error(400, { error: { type: "validation_error", message: "Invalid path" } });

    await mkdirp(resolved.resolved);
    return { path };
  },
  { sessionAuth: true, body: "mkdir-request" },
);

// DELETE /:id/user-file/batch — 批量删除
app.delete(
  "/:id/user-file/batch",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    await requireEnv(params.id, authCtx.organizationId, error);
    const { paths } = body as { paths: string[] };

    const deleted: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    for (const p of paths) {
      if (!isUserPath(p)) {
        failed.push({ path: p, error: "Only user/ paths are allowed" });
        continue;
      }
      try {
        const resolved = await resolveWorkspacePath(params.id, p);
        if (!resolved) {
          failed.push({ path: p, error: "Not found" });
          continue;
        }
        const info = await stat(resolved.resolved);
        if (info.isDirectory()) {
          failed.push({ path: p, error: "Cannot delete directories" });
          continue;
        }
        await deleteFile(resolved.resolved);
        deleted.push(p);
      } catch (e) {
        failed.push({ path: p, error: e instanceof Error ? e.message : "Unknown error" });
      }
    }

    return { deleted, failed };
  },
  { sessionAuth: true, body: "batch-delete-request" },
);

export default app;
