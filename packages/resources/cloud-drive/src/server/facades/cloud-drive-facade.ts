import { CloudDriveError, invalidRequestError } from "../client/cloud-drive-error";
import type { CloudDriveContent, CloudDriveGateway } from "../client/cloud-drive-gateway";
import type {
  CloudDriveAbandonResult,
  CloudDriveFile,
  CloudDriveFilePage,
  CloudDriveMutation,
  CloudDrivePrincipal,
  CloudDriveSearchPage,
  CloudDriveTrashPage,
  CloudDriveUpload,
  CloudDriveUploadResult,
  CloudDriveUploadStatus,
  CloudDriveVersionPage,
} from "../schemas/cloud-drive.schema";
import { type CloudDriveResult, cloudDriveFail, cloudDriveFailureFrom, cloudDriveOk } from "./cloud-drive-result";

/**
 * CloudDrive 的资源应用 Facade：`route → Facade → CloudDrive client` 的应用入口。
 *
 * 本层只有两件事，且都放在这里而不是路由或 client 里：
 *
 * 1. **actor 隔离**：所有方法只接受 `{ userId }`，并且只把 `userId` 作为 `subject` 交给 client。
 *    请求参数里没有、"也不需要"用户标识；路由从守卫写入的 `store.authContext` 投影出 actor。跨用户
 *    隔离由 CloudDrive 按 `(issuer, subject)` 分区保证，Fenix 侧只负责「永远是当前登录用户」。
 * 2. **多步编排**：改名/移动/删除/覆盖写都需要 `expected_metadata_revision`（覆盖写还要
 *    `expected_version_id`），CloudDrive 不会替我们读取。Facade 先 `GET /v1/files/{id}` 取当前元数据，
 *    再带上乐观并发值执行变更；两次调用之间若版本推进，上游返回 `VERSION_CONFLICT` → 409，由前端
 *    刷新后重试。删除/恢复的 revision 语义见各方法注释。
 *
 * 每次写操作生成一个全局唯一 `idempotency_key`：CloudDrive 的写接口都要求它，缺失会被判
 * `INVALID_ARGUMENT`。浏览器重试的语义由此确定（重试 = 新 key = 新操作），这是「不保存状态」的必然
 * 取舍；需要跨请求幂等时由前端用同一个上传会话续传，而不是重复创建上传。
 *
 * 没有 Repository / Domain Service：本模块不落库，也没有独立于远端调用的领域规则；再造两层空壳
 * 只会把「读元数据 → 拼接并发值 → 调用」的编排拆到三个文件里。
 */

/** 会话派生主体；只允许 `userId`，路由不得从请求体或查询串构造它。 */
export interface CloudDriveActor {
  readonly userId: string;
}

export interface ListFilesCommand {
  readonly parentId?: string;
  readonly cursor?: string;
}

export interface ContentCommand {
  readonly versionId?: string;
  readonly range?: string;
}

export interface CreateDirectoryCommand {
  readonly name: string;
  readonly parentId?: string | null;
}

export interface MoveFileCommand {
  readonly name?: string;
  readonly parentId?: string | null;
}

export interface RestoreTrashCommand {
  readonly expectedMetadataRevision: number;
  readonly parentId?: string | null;
  readonly name?: string;
}

export interface SearchCommand {
  readonly query: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface BeginUploadCommand {
  readonly fileId?: string;
  readonly parentId?: string | null;
  readonly name?: string;
  readonly sizeBytes: number;
  readonly contentType?: string;
}

export interface UploadChunkCommand {
  readonly offset: number;
  readonly chunk: Uint8Array<ArrayBuffer>;
}

/** Facade 的契约面；路由与测试都只依赖这组方法。 */
export interface CloudDriveFacade {
  me(actor: CloudDriveActor): Promise<CloudDriveResult<CloudDrivePrincipal>>;
  listFiles(actor: CloudDriveActor, command: ListFilesCommand): Promise<CloudDriveResult<CloudDriveFilePage>>;
  getFile(actor: CloudDriveActor, fileId: string): Promise<CloudDriveResult<CloudDriveFile>>;
  listVersions(actor: CloudDriveActor, fileId: string): Promise<CloudDriveResult<CloudDriveVersionPage>>;
  openContent(
    actor: CloudDriveActor,
    fileId: string,
    command: ContentCommand,
    signal?: AbortSignal,
  ): Promise<CloudDriveResult<CloudDriveContent>>;
  createDirectory(
    actor: CloudDriveActor,
    command: CreateDirectoryCommand,
  ): Promise<CloudDriveResult<CloudDriveMutation>>;
  moveFile(
    actor: CloudDriveActor,
    fileId: string,
    command: MoveFileCommand,
  ): Promise<CloudDriveResult<CloudDriveMutation>>;
  deleteFile(actor: CloudDriveActor, fileId: string): Promise<CloudDriveResult<CloudDriveMutation>>;
  listTrash(actor: CloudDriveActor): Promise<CloudDriveResult<CloudDriveTrashPage>>;
  restoreTrash(
    actor: CloudDriveActor,
    trashId: string,
    command: RestoreTrashCommand,
  ): Promise<CloudDriveResult<CloudDriveMutation>>;
  search(actor: CloudDriveActor, command: SearchCommand): Promise<CloudDriveResult<CloudDriveSearchPage>>;
  beginUpload(actor: CloudDriveActor, command: BeginUploadCommand): Promise<CloudDriveResult<CloudDriveUpload>>;
  getUploadStatus(actor: CloudDriveActor, uploadId: string): Promise<CloudDriveResult<CloudDriveUploadStatus>>;
  uploadChunk(
    actor: CloudDriveActor,
    uploadId: string,
    command: UploadChunkCommand,
    signal?: AbortSignal,
  ): Promise<CloudDriveResult<CloudDriveUploadStatus>>;
  finalizeUpload(actor: CloudDriveActor, uploadId: string): Promise<CloudDriveResult<CloudDriveUploadResult>>;
  abandonUpload(actor: CloudDriveActor, uploadId: string): Promise<CloudDriveResult<CloudDriveAbandonResult>>;
}

export interface CloudDriveFacadeOptions {
  /** 按请求解析出站网关；未配置时抛 `not-configured` 错误（由 Facade 转成 503）。 */
  readonly resolveGateway: () => CloudDriveGateway;
  /** 非 CloudDriveError 的意外异常（编程错误）上报点；默认丢弃，装配时接到宿主日志。 */
  readonly onUnexpectedError?: (error: unknown, context: { readonly operation: string }) => void;
  /** 幂等键生成器；仅测试替换。 */
  readonly newIdempotencyKey?: () => string;
}

/** 创建 CloudDrive Facade；无状态，可按应用生命周期单例化。 */
export function createCloudDriveFacade(options: CloudDriveFacadeOptions): CloudDriveFacade {
  return new DefaultCloudDriveFacade(options);
}

class DefaultCloudDriveFacade implements CloudDriveFacade {
  private readonly newIdempotencyKey: () => string;

  constructor(private readonly options: CloudDriveFacadeOptions) {
    this.newIdempotencyKey = options.newIdempotencyKey ?? (() => crypto.randomUUID());
  }

  me(actor: CloudDriveActor) {
    return this.run(actor, "me", (gateway, subject) => gateway.getMe(subject));
  }

  listFiles(actor: CloudDriveActor, command: ListFilesCommand) {
    return this.run(actor, "listFiles", (gateway, subject) =>
      gateway.listFiles(subject, { parentId: command.parentId, cursor: command.cursor }),
    );
  }

  getFile(actor: CloudDriveActor, fileId: string) {
    return this.run(actor, "getFile", (gateway, subject) => gateway.getFile(subject, fileId));
  }

  listVersions(actor: CloudDriveActor, fileId: string) {
    return this.run(actor, "listVersions", (gateway, subject) => gateway.listVersions(subject, fileId));
  }

  openContent(actor: CloudDriveActor, fileId: string, command: ContentCommand, signal?: AbortSignal) {
    return this.run(actor, "openContent", (gateway, subject) =>
      gateway.openContent(subject, fileId, { versionId: command.versionId, range: command.range }, signal),
    );
  }

  createDirectory(actor: CloudDriveActor, command: CreateDirectoryCommand) {
    return this.run(actor, "createDirectory", (gateway, subject) =>
      gateway.createDirectory(subject, {
        name: command.name,
        parentId: command.parentId ?? undefined,
        idempotencyKey: this.newIdempotencyKey(),
      }),
    );
  }

  async moveFile(actor: CloudDriveActor, fileId: string, command: MoveFileCommand) {
    return this.run(actor, "moveFile", async (gateway, subject) => {
      const file = await gateway.getFile(subject, fileId);
      const name = command.name ?? file.name;
      const parentId = command.parentId === undefined ? file.parentId : command.parentId;
      if (name === file.name && parentId === file.parentId) {
        throw invalidRequestError("CLOUD_DRIVE_NO_CHANGE", "名称与位置均未变化");
      }
      return gateway.moveFile(subject, fileId, {
        name,
        parentId,
        expectedMetadataRevision: file.metadataRevision,
        idempotencyKey: this.newIdempotencyKey(),
      });
    });
  }

  async deleteFile(actor: CloudDriveActor, fileId: string) {
    return this.run(actor, "deleteFile", async (gateway, subject) => {
      const file = await gateway.getFile(subject, fileId);
      return gateway.deleteFile(subject, fileId, {
        expectedMetadataRevision: file.metadataRevision,
        idempotencyKey: this.newIdempotencyKey(),
      });
    });
  }

  listTrash(actor: CloudDriveActor) {
    return this.run(actor, "listTrash", (gateway, subject) => gateway.listTrash(subject));
  }

  restoreTrash(actor: CloudDriveActor, trashId: string, command: RestoreTrashCommand) {
    return this.run(actor, "restoreTrash", (gateway, subject) => {
      if (!Number.isInteger(command.expectedMetadataRevision) || command.expectedMetadataRevision < 1) {
        throw invalidRequestError("CLOUD_DRIVE_REVISION_REQUIRED", "缺少回收站条目的元数据修订号");
      }
      return gateway.restoreTrash(subject, trashId, {
        expectedMetadataRevision: command.expectedMetadataRevision,
        parentId: command.parentId,
        name: command.name,
        idempotencyKey: this.newIdempotencyKey(),
      });
    });
  }

  search(actor: CloudDriveActor, command: SearchCommand) {
    return this.run(actor, "search", (gateway, subject) =>
      gateway.search(subject, { query: command.query, cursor: command.cursor, limit: command.limit }),
    );
  }

  async beginUpload(actor: CloudDriveActor, command: BeginUploadCommand) {
    return this.run(actor, "beginUpload", async (gateway, subject) => {
      if (command.fileId) {
        const file = await gateway.getFile(subject, command.fileId);
        if (file.kind !== "file") throw invalidRequestError("CLOUD_DRIVE_NOT_A_FILE", "目录不能上传内容");
        if (command.name !== undefined && command.name !== file.name) {
          throw invalidRequestError("CLOUD_DRIVE_OVERWRITE_NAME_MISMATCH", "覆盖写不能修改文件名");
        }
        if (command.parentId !== undefined && command.parentId !== file.parentId) {
          throw invalidRequestError("CLOUD_DRIVE_OVERWRITE_MOVE", "覆盖写不能移动文件");
        }
        if (!file.currentVersionId) throw invalidRequestError("CLOUD_DRIVE_NO_VERSION", "文件当前没有可覆盖版本");
        return gateway.beginUpload(subject, {
          fileId: file.id,
          parentId: file.parentId,
          name: file.name,
          sizeBytes: command.sizeBytes,
          contentType: command.contentType ?? file.contentType,
          expectedVersionId: file.currentVersionId,
          expectedMetadataRevision: file.metadataRevision,
          idempotencyKey: this.newIdempotencyKey(),
        });
      }
      if (!command.name) throw invalidRequestError("CLOUD_DRIVE_NAME_REQUIRED", "新建上传必须提供文件名");
      return gateway.beginUpload(subject, {
        name: command.name,
        sizeBytes: command.sizeBytes,
        contentType: command.contentType,
        parentId: command.parentId ?? undefined,
        idempotencyKey: this.newIdempotencyKey(),
      });
    });
  }

  getUploadStatus(actor: CloudDriveActor, uploadId: string) {
    return this.run(actor, "getUploadStatus", (gateway, subject) => gateway.statUpload(subject, uploadId));
  }

  uploadChunk(actor: CloudDriveActor, uploadId: string, command: UploadChunkCommand, signal?: AbortSignal) {
    return this.run(actor, "uploadChunk", (gateway, subject) => {
      if (!Number.isInteger(command.offset) || command.offset < 0) {
        throw invalidRequestError("CLOUD_DRIVE_OFFSET_INVALID", "Upload-Offset 必须是非负整数");
      }
      if (command.chunk.byteLength === 0) {
        throw invalidRequestError("CLOUD_DRIVE_CHUNK_EMPTY", "分片不能为空");
      }
      return gateway.patchUpload(subject, uploadId, { offset: command.offset, chunk: command.chunk }, signal);
    });
  }

  finalizeUpload(actor: CloudDriveActor, uploadId: string) {
    return this.run(actor, "finalizeUpload", (gateway, subject) => gateway.finalizeUpload(subject, uploadId));
  }

  abandonUpload(actor: CloudDriveActor, uploadId: string) {
    return this.run(actor, "abandonUpload", (gateway, subject) => gateway.abandonUpload(subject, uploadId));
  }

  /** 统一入口：actor 校验、网关解析、结果收敛；任何分支都不向路由抛异常。 */
  private async run<T>(
    actor: CloudDriveActor,
    operation: string,
    task: (gateway: CloudDriveGateway, subject: string) => Promise<T>,
  ): Promise<CloudDriveResult<T>> {
    const subject = actor.userId?.trim();
    if (!subject) {
      return cloudDriveFail("invalid", "CLOUD_DRIVE_ACTOR_REQUIRED", "缺少登录用户上下文");
    }
    let gateway: CloudDriveGateway;
    try {
      gateway = this.options.resolveGateway();
    } catch (error) {
      return this.failure(operation, error);
    }
    try {
      return cloudDriveOk(await task(gateway, subject));
    } catch (error) {
      return this.failure(operation, error);
    }
  }

  private failure(operation: string, error: unknown): CloudDriveResult<never> {
    if (!(error instanceof CloudDriveError)) {
      this.options.onUnexpectedError?.(error, { operation });
    }
    return { ok: false, error: cloudDriveFailureFrom(error) };
  }
}
