import { Elysia } from "elysia";
import type { CloudDriveGateway } from "../server/client/cloud-drive-gateway";
import type { SessionAuthContext } from "../server/routes/dependencies";
import type {
  CloudDriveFile,
  CloudDriveMutation,
  CloudDriveUpload,
  CloudDriveUploadStatus,
} from "../server/schemas/cloud-drive.schema";

/**
 * CloudDrive 用例共用的替身与夹具。
 *
 * 全部替换都经**构造注入**（fetch / Gateway / 守卫插件），不使用 `mock.module()`：模块级 mock 会泄漏
 * 到同进程的其它测试文件，且会把「生产依赖形状」替换成测试时才存在的实现。
 */

/** 一个字段齐全的文件行；测试按需覆盖。 */
export function makeFile(overrides: Partial<CloudDriveFile> = {}): CloudDriveFile {
  return {
    id: "file-1",
    parentId: null,
    name: "report.txt",
    path: "/report.txt",
    kind: "file",
    lifecycle: "active",
    sizeBytes: 3,
    contentType: "text/plain",
    currentVersionId: "version-1",
    metadataRevision: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    conversion: null,
    ...overrides,
  };
}

export function makeMutation(overrides: Partial<CloudDriveMutation> = {}): CloudDriveMutation {
  return {
    operationId: "operation-1",
    fileId: "file-1",
    state: "committed",
    errorCode: null,
    compensated: false,
    message: null,
    file: null,
    ...overrides,
  };
}

export function makeUpload(overrides: Partial<CloudDriveUpload> = {}): CloudDriveUpload {
  return {
    uploadId: "upload-1",
    fileId: "file-1",
    operationId: "operation-1",
    status: "uploading",
    expiresAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeUploadStatus(overrides: Partial<CloudDriveUploadStatus> = {}): CloudDriveUploadStatus {
  return { uploadId: "upload-1", offset: 0, length: 10, ...overrides };
}

/** 默认未实现的 Gateway：用例只覆盖自己用到的方法。 */
export function fakeGateway(overrides: Partial<CloudDriveGateway>): CloudDriveGateway {
  const notStubbed = (method: string) => async (): Promise<never> => {
    throw new Error(`Gateway 替身未实现 ${method}`);
  };
  return {
    getMe: notStubbed("getMe"),
    listFiles: notStubbed("listFiles"),
    getFile: notStubbed("getFile"),
    listVersions: notStubbed("listVersions"),
    openContent: notStubbed("openContent"),
    createDirectory: notStubbed("createDirectory"),
    moveFile: notStubbed("moveFile"),
    deleteFile: notStubbed("deleteFile"),
    listTrash: notStubbed("listTrash"),
    restoreTrash: notStubbed("restoreTrash"),
    search: notStubbed("search"),
    beginUpload: notStubbed("beginUpload"),
    statUpload: notStubbed("statUpload"),
    patchUpload: notStubbed("patchUpload"),
    finalizeUpload: notStubbed("finalizeUpload"),
    abandonUpload: notStubbed("abandonUpload"),
    ...overrides,
  };
}

/** JSON 响应助手。 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * 会话守卫替身（与 knowledge 的同名设施同形）。
 *
 * `authContext` 为 null 时进入拒绝模式，用来证明每条端点确实声明了 `sessionAuth: true`。插件名与
 * 宿主守卫不同：Elysia 按插件名去重，同名会让先构造的一方静默生效。
 */
export function createStubSessionAuthGuardPlugin(authContext: SessionAuthContext | null) {
  return new Elysia({ name: "test-cloud-drive-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({ authContext: null as SessionAuthContext | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({
            store,
            error,
          }: {
            store: { authContext: SessionAuthContext | null };
            error: (code: number, body: unknown) => Response;
          }) => {
            if (!authContext) return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
            store.authContext = authContext;
          },
        };
      },
    });
}
